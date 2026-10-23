import { newId, type Item, type Message } from "@agentdesk/protocol";

/**
 * Project a canonical message log into the `Item` view (Codex's Thread/Turn/Item
 * shape). Messages are what the loop needs; items are what a UI renders —
 * one assistant message with three tool calls becomes four items.
 *
 * Deliberately derived, not stored: two copies of the same truth drift.
 * Timestamps come from the storage row, not from `Message`, so the caller
 * supplies one; a per-item timestamp would be a lie when derived.
 */
export function deriveItems(messages: readonly Message[], ts = Date.now()): Item[] {
  const items: Item[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "user":
        items.push({ id: newId("item"), kind: "user_message", ts, text: message.content });
        break;

      case "assistant": {
        if (message.content.length > 0) {
          items.push({
            id: newId("item"),
            kind: "assistant_message",
            ts,
            text: message.content,
          });
        }
        for (const call of message.toolCalls ?? []) {
          items.push({ id: newId("item"), kind: "tool_call", ts, call });
        }
        break;
      }

      case "tool":
        items.push({
          id: newId("item"),
          kind: "tool_result",
          ts,
          callId: message.toolCallId ?? "",
          ok: !message.content.startsWith("ERROR"),
          output: message.content,
        });
        break;

      case "system":
        break; // the policy is a request-level concern, not an item
    }
  }

  return items;
}
