import type { ToolCall } from "./messages";

export type ItemKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result";

/**
 * `Item` is the persisted unit (Thread -> Turn -> Item, borrowed from Codex's
 * app-server model). Events are the live stream; items are the replayable log.
 * Week 3 wires this to SQLite.
 */
export type Item =
  | { id: string; kind: "user_message"; ts: number; text: string }
  | { id: string; kind: "assistant_message"; ts: number; text: string }
  | { id: string; kind: "tool_call"; ts: number; call: ToolCall }
  | {
      id: string;
      kind: "tool_result";
      ts: number;
      callId: string;
      ok: boolean;
      output: string;
    };

export interface Turn {
  readonly id: string;
  readonly threadId: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly items: readonly Item[];
}

export interface Thread {
  readonly id: string;
  readonly createdAt: number;
  readonly turns: readonly Turn[];
}
