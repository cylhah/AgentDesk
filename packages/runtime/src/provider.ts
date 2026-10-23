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
  /**
   * Real token accounting for *this request*, when the endpoint reports it.
   * The loop prefers this over `estimateTokens` — otherwise every number in the
   * eval table (and cost later) is a guess derived from character counts.
   */
  readonly usage?: ModelUsage;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
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
