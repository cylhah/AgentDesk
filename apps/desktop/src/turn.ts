import { newId, type Message } from "@agentdesk/protocol";
import type { EventBroker } from "@agentdesk/eventstream";
import {
  makeProviderSummarizer,
  openAIProviderFromEnv,
  runTurn,
  type ModelProvider,
  type RunTurnResult,
} from "@agentdesk/runtime";
import type { SessionStore } from "@agentdesk/store";
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
  readonly pending: PendingApproval | null;
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
  private pending: PendingApproval | null = null;
  private reason: string | null = null;
  private summary: { text: string; frontier: number } | undefined;
  /** How many of `messages` are already on disk — avoids re-appending on resume. */
  private persisted = 0;
  private readonly provider: ModelProvider;

  constructor(private readonly options: TurnRunnerOptions) {
    this.provider = options.provider ?? openAIProviderFromEnv();
  }

  state(): TurnState {
    return { threadId: this.threadId, pending: this.pending, reason: this.reason };
  }

  async start(task: string): Promise<TurnState> {
    const threadId = newId("thread");
    const turnId = newId("turn");
    this.threadId = threadId;
    this.turnId = turnId;
    this.persisted = 0;

    this.messages = [{ role: "user", content: task }];
    await this.options.store.create({
      threadId,
      cwd: this.options.cwd,
      provider: this.provider.id,
      system: this.options.scenario.systemPrompt,
    });

    await this.drive();
    return this.state();
  }

  async resolve(decision: "approve" | "deny"): Promise<TurnState> {
    if (this.pending === null) throw new Error("no pending approval");
    const pending = this.pending;
    this.pending = null;
    await this.drive({ callId: pending.callId, decision });
    return this.state();
  }

  /** One `runTurn` segment: parks on approval, otherwise records the turn. */
  private async drive(resume?: { callId: string; decision: "approve" | "deny" }): Promise<void> {
    const threadId = this.threadId;
    const turnId = this.turnId;
    if (threadId === null || turnId === null) throw new Error("turn has not started");

    const result: RunTurnResult = await runTurn({
      threadId,
      turnId,
      messages: this.messages,
      provider: this.provider,
      tools: this.options.scenario.tools,
      system: this.options.scenario.systemPrompt,
      cwd: this.options.cwd,
      streaming: this.options.streaming ?? true,
      ...(resume !== undefined ? { resume } : {}),
      ...(this.summary !== undefined ? { priorSummary: this.summary } : {}),
      ...(this.options.summarize === true
        ? { summarizer: makeProviderSummarizer(this.provider) }
        : {}),
      onEvent: (event) => {
        this.options.broker.publish(event);
      },
    });

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

    if (result.reason === "awaiting_approval" && result.pendingApproval !== undefined) {
      const pending = result.pendingApproval;
      this.pending = {
        threadId,
        turnId,
        callId: pending.callId,
        name: pending.tool.name,
        args: pending.args,
      };
      return; // same turnId and messages: `resolve` continues it
    }

    await this.options.store.appendTurn(threadId, {
      turnId,
      reason: result.reason,
      usage: result.usage,
    });
    this.turnId = null;
  }
}
