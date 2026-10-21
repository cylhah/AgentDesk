import type { Message } from "@agentdesk/protocol";
import { compactMessages, DEFAULT_TOOL_RESULT_CHARS } from "@agentdesk/runtime";
import { describe, expect, it } from "vitest";

const big = (size: number, marker: string): string => `${marker}${"x".repeat(size)}`;

/** One realistic turn: user → assistant(tool call) → tool result. */
function turn(index: number, resultChars: number): Message[] {
  const callId = `c${index}`;
  return [
    { role: "user", content: `问题 ${index}` },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: "fs_read", args: { path: `f${index}.ts` } }],
    },
    { role: "tool", toolCallId: callId, content: big(resultChars, `result-${index}-`) },
  ];
}

describe("compactMessages", () => {
  it("leaves a short conversation untouched", () => {
    const messages = turn(1, 100);
    const { messages: out, report } = compactMessages(messages);

    expect(report.changed).toBe(false);
    expect(out).toEqual(messages);
  });

  it("truncates old tool results but keeps the most recent ones verbatim", () => {
    const messages = [
      ...turn(1, 10_000),
      ...turn(2, 10_000),
      ...turn(3, 10_000),
      ...turn(4, 10_000),
      ...turn(5, 10_000),
      ...turn(6, 10_000),
    ];

    const { messages: out, report } = compactMessages(messages, {
      maxContextTokens: 1_000_000, // truncation must happen on its own, not because of the budget
    });

    expect(report.truncatedToolResults).toBe(2); // 6 turns, last 4 kept verbatim
    const toolContents = out
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
    expect(toolContents[0]).toContain("truncated");
    expect(toolContents[0]?.length).toBeLessThan(10_000);
    expect(toolContents[0]?.length).toBeLessThan(DEFAULT_TOOL_RESULT_CHARS + 100);
    expect(toolContents[5]?.length).toBeGreaterThan(DEFAULT_TOOL_RESULT_CHARS);
  });

  it("elides old tool results before dropping structure", () => {
    const messages = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((index) => turn(index, 4_000));

    // Budget sits between "after truncation" and "after elision", so this case
    // isolates stage 2 — dropping is asserted separately below.
    const { messages: out, report } = compactMessages(messages, { maxContextTokens: 4_500 });

    expect(report.elidedToolResults).toBeGreaterThan(0);
    expect(report.droppedMessages).toBe(0);
    expect(out.some((message) => message.content.startsWith("[elided"))).toBe(true);
  });

  it("drops whole old turns and never orphans a tool call", () => {
    const messages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((index) => turn(index, 4_000));

    const { messages: out, report } = compactMessages(messages, { maxContextTokens: 500 });

    expect(report.droppedMessages).toBeGreaterThan(0);
    expect(out[0]?.role).toBe("user");

    const toolCallIds = new Set(
      out.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []),
    );
    for (const callId of toolCallIds) {
      expect(out.some((message) => message.toolCallId === callId)).toBe(true);
    }
    for (const message of out) {
      if (message.role === "tool") {
        expect(toolCallIds.has(message.toolCallId ?? "")).toBe(true);
      }
    }
  });

  it("keeps the last user message even when it alone exceeds the budget", () => {
    const messages: Message[] = [{ role: "user", content: big(100_000, "huge-") }];
    const { messages: out } = compactMessages(messages, { maxContextTokens: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]?.content.startsWith("huge-")).toBe(true);
  });

  it("is idempotent: compacting twice does not stack truncation markers", () => {
    const messages = [
      ...turn(1, 10_000),
      ...turn(2, 10_000),
      ...turn(3, 10_000),
      ...turn(4, 10_000),
      ...turn(5, 10_000),
      ...turn(6, 10_000),
    ];
    const once = compactMessages(messages, { maxContextTokens: 1_000_000 }).messages;
    const twice = compactMessages(once, { maxContextTokens: 1_000_000 }).messages;
    expect(twice).toEqual(once);
  });
});
