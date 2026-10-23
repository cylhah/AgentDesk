import type { AssistantTurn, CompletionRequest, ModelProvider } from "./provider";

/**
 * Replays a fixed script of assistant turns. Two uses:
 *  1. tests — deterministic, no network;
 *  2. Week 2 eval — fixtures encode the "ideal model", so the harness itself
 *     can be scored before you pay for a single token.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  private readonly queue: AssistantTurn[];

  constructor(turns: readonly AssistantTurn[], id = "scripted") {
    this.id = id;
    this.queue = turns.map((turn) => ({
      text: turn.text,
      toolCalls: [...turn.toolCalls],
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    }));
  }

  get remaining(): number {
    return this.queue.length;
  }

  async complete(_req: CompletionRequest): Promise<AssistantTurn> {
    const next = this.queue.shift();
    return next ?? { text: "", toolCalls: [] };
  }
}
