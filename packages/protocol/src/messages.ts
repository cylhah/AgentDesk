export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * The canonical conversation unit. Providers translate this into whatever
 * their wire format is; the runtime never sees provider-specific shapes.
 */
export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
}
