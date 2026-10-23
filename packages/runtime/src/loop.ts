import {
  estimateTokens,
  newId,
  now,
  toToolSpec,
  type AgentEvent,
  type Message,
  type ToolDef,
  type TurnEndReason,
} from "@agentdesk/protocol";
import type { ModelProvider } from "./provider";
import { compactMessages, type CompactionOptions } from "./context";
import { splitForSummary, summaryMessage, type Summarizer } from "./summarize";

const DEFAULT_SUMMARIZE_AT_TOKENS = 24_000;
const DEFAULT_SUMMARIZE_KEEP_TURNS = 4;

export interface ApprovalRequest {
  readonly tool: ToolDef;
  readonly args: unknown;
  readonly callId: string;
}

/**
 * Returning `true` executes the tool now; `false` (or omitting the callback
 * entirely) halts the turn with `awaiting_approval` so a host can resume later.
 */
export type ApprovalFn = (req: ApprovalRequest) => Promise<boolean> | boolean;

export interface RunTurnInput {
  readonly threadId: string;
  readonly messages: readonly Message[];
  readonly provider: ModelProvider;
  readonly tools: readonly ToolDef[];
  readonly system?: string;
  readonly maxSteps?: number;
  readonly tokenBudget?: number;
  /** Per-request context window handling. The full history is still kept in memory/on disk. */
  readonly context?: CompactionOptions;
  /**
   * Optional semantic compression. When provided and the request exceeds
   * `atTokens`, older turns are replaced by one summary paragraph for the
   * request only — the recorded history stays intact.
   */
  readonly summarizer?: Summarizer;
  readonly summarizeAt?: {
    readonly atTokens?: number;
    readonly keepRecentTurns?: number;
  };
  /** Summary carried over from a previous turn — recomputing it costs a full extra request. */
  readonly priorSummary?: { readonly text: string; readonly frontier: number };
  readonly approval?: ApprovalFn;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly cwd?: string;
  readonly turnId?: string;
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly steps: number;
}

export interface RunTurnResult {
  readonly turnId: string;
  readonly reason: TurnEndReason;
  readonly messages: readonly Message[];
  readonly usage: TokenUsage;
  readonly pendingApproval?: ApprovalRequest;
  /** New or refreshed summary of the head of the conversation — persist it, or pay again next turn. */
  readonly summary?: { readonly text: string; readonly frontier: number };
}

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_TOKEN_BUDGET = 60_000;

/**
 * One turn = one user request + every step the agent takes to answer it.
 *
 * Deliberately a plain loop, not a planner graph: at this size a loop you can
 * read top-to-bottom is easier to reason about than an orchestration framework.
 * Revisit only if you can name a concrete case where it fails.
 */
export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const turnId = input.turnId ?? newId("turn");
  const emit = (event: AgentEvent): void => {
    input.onEvent?.(event);
  };
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const cwd = input.cwd ?? process.cwd();
  const messages: Message[] = [...input.messages];

  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let usedEstimate = false;
  let reason: TurnEndReason = "max_steps";
  let pendingApproval: ApprovalRequest | undefined;
  /** Summarised head of the conversation; reused from the previous turn when available. */
  let summary: { text: string; frontier: number } | undefined =
    input.priorSummary !== undefined && input.priorSummary.frontier <= messages.length
      ? { text: input.priorSummary.text, frontier: input.priorSummary.frontier }
      : undefined;

  emit({ type: "turn.start", turnId, ts: now() });

  outer: for (; steps < maxSteps; steps += 1) {
    if (input.signal?.aborted === true) {
      reason = "aborted";
      break;
    }
    if (inputTokens + outputTokens > tokenBudget) {
      reason = "budget_exceeded";
      break;
    }

    if (input.summarizer !== undefined) {
      const atTokens = input.summarizeAt?.atTokens ?? DEFAULT_SUMMARIZE_AT_TOKENS;
      // Only the *uncovered* tail matters: a stored summary already stands in
      // for everything before its frontier.
      const tailFrom = summary === undefined ? 0 : summary.frontier;
      const tailTokens = messages
        .slice(tailFrom)
        .reduce((sum, message) => sum + estimateTokens(message.content), 0);
      if (tailTokens > atTokens) {
        const keepRecentTurns =
          input.summarizeAt?.keepRecentTurns ?? DEFAULT_SUMMARIZE_KEEP_TURNS;
        const { head, tail } = splitForSummary(messages, keepRecentTurns);
        const alreadyCovered = summary?.frontier ?? 0;
        if (head.length > alreadyCovered) {
          const summarized = await input.summarizer(head);
          summary = { text: summarized.text, frontier: head.length };
          // The summary is a paid request too — account for it before emitting.
          if (summarized.usage !== undefined) {
            inputTokens += summarized.usage.inputTokens;
            outputTokens += summarized.usage.outputTokens;
          } else {
            usedEstimate = true;
            inputTokens += head.reduce(
              (sum, message) => sum + estimateTokens(message.content),
              0,
            );
            outputTokens += estimateTokens(summarized.text);
          }
          emit({
            type: "context.summarized",
            turnId,
            ts: now(),
            tokensBefore: tailTokens,
            tokensAfter:
              estimateTokens(summarized.text) +
              tail.reduce((sum, message) => sum + estimateTokens(message.content), 0),
            summarizedMessages: head.length,
            keptMessages: tail.length,
          });
        }
      }
    }

    const requestMessages: readonly Message[] =
      summary === undefined
        ? messages
        : [summaryMessage(summary.text), ...messages.slice(summary.frontier)];

    const compacted = compactMessages(requestMessages, input.context ?? {});
    if (compacted.report.changed) {
      emit({
        type: "context.compacted",
        turnId,
        ts: now(),
        tokensBefore: compacted.report.tokensBefore,
        tokensAfter: compacted.report.tokensAfter,
        truncatedToolResults: compacted.report.truncatedToolResults,
        elidedToolResults: compacted.report.elidedToolResults,
        droppedMessages: compacted.report.droppedMessages,
      });
    }

    const turn = await input.provider.complete({
      messages: compacted.messages,
      tools: input.tools.map(toToolSpec),
      ...(input.system !== undefined ? { system: input.system } : {}),
    });

    // Prefer the endpoint's own numbers: each request repays for the whole
    // prompt, so summing per-step usage is the actual bill, while the estimate
    // is only a stand-in for scripted providers and endpoints that omit usage.
    if (turn.usage !== undefined) {
      inputTokens += turn.usage.inputTokens;
      outputTokens += turn.usage.outputTokens;
    } else {
      usedEstimate = true;
      inputTokens += messages.reduce(
        (sum, message) => sum + estimateTokens(message.content),
        0,
      );
      outputTokens += estimateTokens(turn.text);
    }

    if (turn.text.length > 0) {
      emit({ type: "message.delta", turnId, text: turn.text, ts: now() });
      emit({ type: "message.complete", turnId, text: turn.text, ts: now() });
    }

    // No tool calls means the model considers the task done.
    if (turn.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: turn.text });
      reason = "completed";
      break;
    }

    messages.push({
      role: "assistant",
      content: turn.text,
      toolCalls: turn.toolCalls,
    });

    for (const call of turn.toolCalls) {
      const tool = input.tools.find((candidate) => candidate.name === call.name);

      if (tool === undefined) {
        emit({
          type: "error",
          turnId,
          message: `unknown tool: ${call.name}`,
          recoverable: true,
          ts: now(),
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `ERROR unknown tool: ${call.name}`,
        });
        continue;
      }

      if (tool.risk === "forbidden") {
        emit({
          type: "error",
          turnId,
          message: `forbidden tool: ${tool.name}`,
          recoverable: true,
          ts: now(),
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `ERROR tool ${tool.name} is disabled by policy`,
        });
        continue;
      }

      const parsed = tool.parameters.safeParse(call.args);
      if (!parsed.success) {
        // Feed the validation error back instead of crashing: this is the
        // cheapest self-repair loop a model has.
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        emit({
          type: "error",
          turnId,
          message: `invalid args for ${tool.name}: ${detail}`,
          recoverable: true,
          ts: now(),
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `ERROR invalid args for ${tool.name}: ${detail}`,
        });
        continue;
      }

      if (tool.risk === "confirm") {
        // No callback at all means "nobody to ask yet" — a UI that will ask
        // later resumes the turn. A callback that returns false is a *decision*
        // (denied), which the model must see and react to like any other error.
        if (input.approval === undefined) {
          emit({
            type: "tool.approval_required",
            turnId,
            callId: call.id,
            name: tool.name,
            args: parsed.data,
            risk: tool.risk,
            ts: now(),
          });
          pendingApproval = { tool, args: parsed.data, callId: call.id };
          reason = "awaiting_approval";
          break outer;
        }

        const approved = await input.approval({
          tool,
          args: parsed.data,
          callId: call.id,
        });

        if (!approved) {
          emit({
            type: "error",
            turnId,
            message: `denied by user: ${tool.name}`,
            recoverable: true,
            ts: now(),
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: `ERROR user denied ${tool.name} — do not retry, explain what you cannot do`,
          });
          continue;
        }
      }

      emit({
        type: "tool.call",
        turnId,
        callId: call.id,
        name: tool.name,
        args: parsed.data,
        ts: now(),
      });

      const startedAt = now();
      let ok = false;
      let output = "";
      try {
        const result = await tool.run(parsed.data, {
          threadId: input.threadId,
          turnId,
          cwd,
        });
        ok = result.ok;
        output = result.output;
      } catch (error) {
        output = `ERROR ${error instanceof Error ? error.message : String(error)}`;
      }

      emit({
        type: "tool.result",
        turnId,
        callId: call.id,
        ok,
        output,
        durationMs: now() - startedAt,
        ts: now(),
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: ok ? output : `ERROR ${output}`,
      });
    }
  }

  const tokenSource = usedEstimate ? "estimate" : "api";
  emit({ type: "usage", turnId, inputTokens, outputTokens, source: tokenSource, ts: now() });
  emit({ type: "turn.end", turnId, reason, ts: now() });

  return {
    turnId,
    reason,
    messages,
    usage: { inputTokens, outputTokens, steps },
    ...(pendingApproval !== undefined ? { pendingApproval } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}
