import { newId, type AgentEvent, type Message } from "@agentdesk/protocol";
import type { EventBroker } from "@agentdesk/eventstream";
import {
  makeProviderSummarizer,
  openAIProviderFromEnv,
  runTurn,
  type ModelProvider,
  type RunTurnResult,
} from "@agentdesk/runtime";
import type { AuditLog, SessionStore } from "@agentdesk/store";
import type { Scenario } from "@agentdesk/tools";

export interface PendingApproval {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface TurnState {
  readonly threadId: string | null;
  readonly pending: readonly PendingApproval[];
  readonly reason: string | null;
}

export interface TurnRunnerOptions {
  readonly store: SessionStore;
  readonly broker: EventBroker;
  readonly scenario: Scenario;
  readonly cwd: string;
  readonly provider?: ModelProvider;
  readonly streaming?: boolean;
  readonly summarize?: boolean;
  /** Same trail the CLI writes — approvals decided in the dashboard must be auditable too. */
  readonly audit?: AuditLog;
}

/**
 * Runs a turn *in the host process* and parks it when a dangerous tool needs
 * approval. The view can only resolve that parked call — it cannot submit new
 * tasks (remote task submission is deliberately out of scope). So the operator
 * starts the turn at the machine (`pnpm ui --run "..."`) and clicks in the
 * dashboard instead of typing `y` in a terminal.
 */
export class TurnRunner {
  private messages: Message[] = [];
  private threadId: string | null = null;
  private turnId: string | null = null;
  private pending: PendingApproval[] = [];
  private reason: string | null = null;
  private summary: { text: string; frontier: number } | undefined;
  /** How many of `messages` are already on disk — avoids re-appending on resume. */
  private persisted = 0;
  /** Sum of every segment the turn made (a parked turn is several requests). */
  private usage = { inputTokens: 0, outputTokens: 0, steps: 0 };
  private readonly provider: ModelProvider;

  constructor(private readonly options: TurnRunnerOptions) {
    this.provider = options.provider ?? openAIProviderFromEnv();
  }

  state(): TurnState {
    return { threadId: this.threadId, pending: this.pending, reason: this.reason };
  }

  /**
   * Runs one more turn. Consecutive tasks stay in the **same thread** — that is
   * what makes "换一首" work and what keeps the sidebar from turning one
   * conversation into five. `newSession()` is the explicit way to start over.
   */
  async start(task: string): Promise<TurnState> {
    if (this.turnId !== null) {
      throw new Error("a turn is already in progress — settle or finish it first");
    }

    const turnId = newId("turn");
    this.turnId = turnId;
    this.usage = { inputTokens: 0, outputTokens: 0, steps: 0 };

    if (this.threadId === null) {
      this.threadId = newId("thread");
      this.messages = [];
      this.persisted = 0;
      await this.options.store.create({
        threadId: this.threadId,
        cwd: this.options.cwd,
        provider: this.provider.id,
        system: this.options.scenario.systemPrompt,
      });
    }

    const userMessage: Message = { role: "user", content: task };
    this.messages = [...this.messages, userMessage];
    await this.options.store.appendMessage(this.threadId, turnId, userMessage);
    this.persisted = this.messages.length;

    await this.drive();
    return this.state();
  }

  /** Forgets the current conversation; the next `start` opens a new thread. */
  newSession(): TurnState {
    if (this.turnId !== null) {
      throw new Error("a turn is in progress — finish it before starting a new session");
    }
    this.threadId = null;
    this.turnId = null;
    this.messages = [];
    this.persisted = 0;
    this.pending = [];
    this.summary = undefined;
    this.reason = null;
    return this.state();
  }

  /**
   * Settles a batch. The loop parked every confirm call of the last step, so a
   * partial answer would leave unreachable calls in the history — callers must
   * decide all of them (the UI sends one decision per row).
   */
  async resolve(decisions: readonly { callId: string; decision: "approve" | "deny" }[]): Promise<TurnState> {
    if (this.pending.length === 0) throw new Error("no pending approval");
    const outstanding = new Set(this.pending.map((entry) => entry.callId));
    for (const decision of decisions) {
      if (!outstanding.has(decision.callId)) {
        throw new Error(`no pending approval for ${decision.callId}`);
      }
    }
    const decided = new Set(decisions.map((entry) => entry.callId));
    const missing = [...outstanding].filter((callId) => !decided.has(callId));
    if (missing.length > 0) {
      throw new Error(`decision required for: ${missing.join(", ")}`);
    }

    this.pending = [];
    await this.drive(decisions);
    return this.state();
  }

  /** One `runTurn` segment: parks on approval, otherwise records the turn. */
  private async drive(
    decisions?: readonly { callId: string; decision: "approve" | "deny" }[],
  ): Promise<void> {
    const threadId = this.threadId;
    const turnId = this.turnId;
    if (threadId === null || turnId === null) throw new Error("turn has not started");

    const events: AgentEvent[] = [];
    const result: RunTurnResult = await runTurn({
      threadId,
      turnId,
      messages: this.messages,
      provider: this.provider,
      tools: this.options.scenario.tools,
      system: this.options.scenario.systemPrompt,
      cwd: this.options.cwd,
      streaming: this.options.streaming ?? true,
      ...(decisions !== undefined ? { resume: { decisions } } : {}),
      ...(this.summary !== undefined ? { priorSummary: this.summary } : {}),
      ...(this.options.summarize === true
        ? { summarizer: makeProviderSummarizer(this.provider) }
        : {}),
      onEvent: (event) => {
        events.push(event);
        this.options.broker.publish(event);
      },
    });

    await this.recordAudit(turnId, events);

    this.usage = {
      inputTokens: this.usage.inputTokens + result.usage.inputTokens,
      outputTokens: this.usage.outputTokens + result.usage.outputTokens,
      steps: this.usage.steps + result.usage.steps,
    };

    this.messages = [...result.messages];
    this.reason = result.reason;

    if (result.summary !== undefined) {
      await this.options.store.saveSummary(threadId, result.summary);
      this.summary = result.summary;
    }

    // Persist everything new, including a parked tool call (no result yet).
    for (const message of this.messages.slice(this.persisted)) {
      await this.options.store.appendMessage(threadId, turnId, message);
    }
    this.persisted = this.messages.length;

    if (result.reason === "awaiting_approval" && (result.pendingApprovals?.length ?? 0) > 0) {
      this.pending = (result.pendingApprovals ?? []).map((pending) => ({
        threadId,
        turnId,
        callId: pending.callId,
        name: pending.tool.name,
        args: pending.args,
      }));
      return; // same turnId and messages: `resolve` continues it
    }

    await this.options.store.appendTurn(threadId, {
      turnId,
      reason: result.reason,
      usage: this.usage,
    });

    await this.options.audit?.record({
      threadId,
      turnId,
      kind: "turn",
      cwd: this.options.cwd,
      reason: result.reason,
      tokens: { input: this.usage.inputTokens, output: this.usage.outputTokens },
    });
    this.turnId = null;
  }

  /**
   * Audit is derived from the event stream, same as the CLI. Approvals decided
   * by a click in the dashboard are exactly the ones an audit trail exists for.
   */
  private async recordAudit(turnId: string, events: readonly AgentEvent[]): Promise<void> {
    const audit = this.options.audit;
    const threadId = this.threadId;
    if (audit === undefined || threadId === null) return;

    const results = new Map(
      events
        .filter((event) => event.type === "tool.result")
        .map((event) => [event.type === "tool.result" ? event.callId : "", event]),
    );

    for (const event of events) {
      if (event.type === "tool.approval_resolved") {
        await audit.record({
          threadId,
          turnId,
          kind: "approval",
          cwd: this.options.cwd,
          tool: event.name,
          decision: event.decision === "approve" ? "approved" : "denied",
        });
      }

      if (event.type === "tool.call") {
        const tool = this.options.scenario.tools.find((entry) => entry.name === event.name);
        const outcome = results.get(event.callId);
        const args = JSON.stringify(event.args ?? {});
        await audit.record({
          threadId,
          turnId,
          kind: "tool",
          cwd: this.options.cwd,
          tool: event.name,
          ...(tool !== undefined ? { risk: tool.risk } : {}),
          ...(outcome !== undefined
            ? {
                ok: outcome.type === "tool.result" ? outcome.ok : undefined,
                durationMs: outcome.type === "tool.result" ? outcome.durationMs : undefined,
              }
            : {}),
          args: args.length > 200 ? `${args.slice(0, 200)}…` : args,
        });
      }
    }
  }
}
