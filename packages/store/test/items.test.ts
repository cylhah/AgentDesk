import type { Message } from "@agentdesk/protocol";
import { deriveItems } from "@agentdesk/store";
import { describe, expect, it } from "vitest";

describe("deriveItems", () => {
  it("splits one assistant message into a text item and one item per tool call", () => {
    const messages: Message[] = [
      { role: "user", content: "放晴天" },
      {
        role: "assistant",
        content: "我查一下。",
        toolCalls: [
          { id: "c1", name: "search_media", args: { query: "晴天" } },
          { id: "c2", name: "play", args: { trackId: "t-001" } },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "[]" },
      { role: "tool", toolCallId: "c2", content: '{"nowPlaying":"晴天"}' },
    ];

    const items = deriveItems(messages, 1_700_000_000_000);

    expect(items.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ]);
    expect(items.every((item) => item.ts === 1_700_000_000_000)).toBe(true);
    const calls = items.filter((item) => item.kind === "tool_call");
    expect(calls.map((call) => (call.kind === "tool_call" ? call.call.name : ""))).toEqual([
      "search_media",
      "play",
    ]);
  });

  it("marks failed tool results by their ERROR prefix", () => {
    const items = deriveItems([
      { role: "tool", toolCallId: "c1", content: "ERROR user denied set_window" },
      { role: "tool", toolCallId: "c2", content: '{"ok":true}' },
    ]);

    const results = items.filter((item) => item.kind === "tool_result");
    expect(results.map((item) => (item.kind === "tool_result" ? item.ok : null))).toEqual([
      false,
      true,
    ]);
  });

  it("skips empty assistant text but keeps its tool calls", () => {
    const items = deriveItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "play", args: { trackId: "t-001" } }],
      },
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool_call"]);
  });

  it("does not turn the system policy into an item", () => {
    expect(deriveItems([{ role: "system", content: "policy" }])).toEqual([]);
  });
});
