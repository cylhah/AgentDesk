import type { Message, ToolCall, ToolSpec } from "@agentdesk/protocol";

export interface CompletionRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly system?: string;
}

/** What the model handed back for one step. Text and/or tool calls. */
export interface AssistantTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
}

/**
 * The only place that knows about a specific model vendor.
 * Everything upstream (loop, tools, approval, eval) is provider-agnostic —
 * that is what lets Week 8 swap providers and compare cost.
 */
export interface ModelProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<AssistantTurn>;
}
