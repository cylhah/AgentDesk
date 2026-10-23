import type { Message } from "@agentdesk/protocol";
import {
  makeProviderSummarizer,
  runTurn,
  splitForSummary,
  toTranscript,
  type ModelProvider,
} from "@agentdesk/runtime";
import { createMockMediaTools } from "@agentdesk/tools";
import { describe, expect, it } from "vitest";

const turn = (index: number): Message[] => [
  { role: "user", content: `问题 ${index}` },
  { role: "assistant", content: `回答 ${index}` },
];

describe("splitForSummary", () => {
  it("cuts at a user boundary and keeps the last N turns", () => {
    const messages = [1, 2, 3, 4, 5, 6].flatMap((index) => turn(index));
    const { head, tail } = splitForSummary(messages, 2);

    expect(head).toHaveLength(8); // 4 turns
    expect(tail).toHaveLength(4); // 2 turns
    expect(tail[0]?.role).toBe("user");
    expect(tail[0]?.content).toBe("问题 5");
  });

  it("keeps everything when there are fewer turns than requested", () => {
    const { head, tail } = splitForSummary(turn(1), 4);
    expect(head).toHaveLength(0);
    expect(tail).toHaveLength(2);
  });
});

describe("toTranscript", () => {
  it("keeps tool calls visible and truncates long payloads", () => {
    const text = toTranscript([
      { role: "user", content: "放晴天" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "play", args: { trackId: "t-001" } }],
      },
      { role: "tool", content: "x".repeat(2_000), toolCallId: "c1" },
    ]);

    expect(text).toContain("[user] 放晴天");
    expect(text).toContain('play({"trackId":"t-001"})');
    expect(text).toContain("[工具结果]");
    expect(text.length).toBeLessThan(1_200);
  });
});

describe("runTurn + summarizer", () => {
  const tools = createMockMediaTools();

  it("summarises the old head once and keeps the recorded history intact", async () => {
    const requests: (readonly Message[])[] = [];
    const provider: ModelProvider = {
      id: "spy",
      async complete(req) {
        requests.push(req.messages);
        return requests.length === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "play", args: { trackId: "t-001" } }] }
          : { text: "好了", toolCalls: [] };
      },
    };

    const history = [1, 2, 3, 4, 5, 6].flatMap((index) => turn(index));
    let summarisedInput: readonly Message[] = [];
    const events: string[] = [];

    const result = await runTurn({
      threadId: "thread_1",
      messages: history,
      provider,
      tools,
      summarizer: async (messages) => {
        summarisedInput = messages;
        return { text: "用户问了 1–4 的问题，工具调用成功。", usage: { inputTokens: 100, outputTokens: 10 } };
      },
      summarizeAt: { atTokens: 1, keepRecentTurns: 2 },
      onEvent: (event) => events.push(event.type),
    });

    // The model only ever sees the summary + the kept tail, never the raw head.
    expect(requests).toHaveLength(2);
    expect(summarisedInput).toHaveLength(8);
    for (const request of requests) {
      expect(request[0]?.content).toContain("早前对话摘要");
      expect(request.some((message) => message.content === "问题 1")).toBe(false);
      expect(request.some((message) => message.content === "问题 6")).toBe(true);
    }

    expect(events.filter((type) => type === "context.summarized")).toHaveLength(1);
    // The transcript on disk keeps everything; only the request was compressed.
    expect(result.messages.some((message) => message.content === "问题 1")).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(100); // summary cost is counted
  });

  it("reuses a persisted summary instead of paying for a new one", async () => {
    const provider: ModelProvider = {
      id: "p",
      async complete() {
        return { text: "好", toolCalls: [] };
      },
    };
    let summarizerCalls = 0;
    const events: string[] = [];
    const requests: (readonly Message[])[] = [];
    const spy: ModelProvider = {
      id: "spy",
      async complete(req) {
        requests.push(req.messages);
        return provider.complete(req);
      },
    };

    const result = await runTurn({
      threadId: "thread_1",
      messages: [1, 2, 3, 4, 5, 6].flatMap((index) => turn(index)),
      provider: spy,
      tools,
      priorSummary: { text: "早前：用户问了 1–4", frontier: 8 },
      summarizer: async () => {
        summarizerCalls += 1;
        return { text: "不该被调用" };
      },
      summarizeAt: { atTokens: 1, keepRecentTurns: 2 },
      onEvent: (event) => events.push(event.type),
    });

    expect(summarizerCalls).toBe(0);
    expect(events).not.toContain("context.summarized");
    expect(requests[0]?.[0]?.content).toContain("早前：用户问了 1–4");
    // The covered head is not sent, the kept tail is.
    expect(requests[0]?.some((message) => message.content === "问题 1")).toBe(false);
    expect(result.summary).toEqual({ text: "早前：用户问了 1–4", frontier: 8 });
  });

  it("does nothing when no summarizer is supplied", async () => {
    const provider: ModelProvider = {
      id: "p",
      async complete() {
        return { text: "好", toolCalls: [] };
      },
    };
    const events: string[] = [];

    await runTurn({
      threadId: "thread_1",
      messages: [1, 2, 3, 4, 5, 6].flatMap((index) => turn(index)),
      provider,
      tools,
      summarizeAt: { atTokens: 1 },
      onEvent: (event) => events.push(event.type),
    });

    expect(events).not.toContain("context.summarized");
  });

  it("does nothing while the request is still small", async () => {
    const provider: ModelProvider = {
      id: "p",
      async complete() {
        return { text: "好", toolCalls: [] };
      },
    };
    const events: string[] = [];
    let called = false;

    await runTurn({
      threadId: "thread_1",
      messages: turn(1),
      provider,
      tools,
      summarizer: async () => {
        called = true;
        return { text: "不该被调用" };
      },
      summarizeAt: { atTokens: 10_000 },
      onEvent: (event) => events.push(event.type),
    });

    expect(called).toBe(false);
    expect(events).not.toContain("context.summarized");
  });

  it("wraps a provider as a summarizer and reports its usage", async () => {
    const provider: ModelProvider = {
      id: "p",
      async complete() {
        return { text: "  摘要正文  ", toolCalls: [], usage: { inputTokens: 50, outputTokens: 5 } };
      },
    };

    const output = await makeProviderSummarizer(provider)(turn(1));
    expect(output.text).toBe("摘要正文");
    expect(output.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
  });
});
