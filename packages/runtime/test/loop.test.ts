import type { AgentEvent } from "@agentdesk/protocol";
import { runTurn, ScriptedProvider, type ModelProvider } from "@agentdesk/runtime";
import { createMockMediaTools } from "@agentdesk/tools";
import { describe, expect, it } from "vitest";

const tools = createMockMediaTools();
const userSays = (text: string) => [{ role: "user" as const, content: text }];

describe("runTurn", () => {
  it("executes a tool call and completes when the model stops calling tools", async () => {
    const provider = new ScriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "search_media", args: { query: "晴天" } }] },
      { text: "找到了《晴天》。", toolCalls: [] },
    ]);

    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("放晴天"),
      provider,
      tools,
    });

    expect(result.reason).toBe("completed");
    expect(result.usage.steps).toBeGreaterThan(0);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("halts with awaiting_approval when a confirm-risk tool has no approval callback", async () => {
    const provider = new ScriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "set_window", args: { action: "open" } }] },
    ]);

    const events: AgentEvent[] = [];
    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("开车窗"),
      provider,
      tools,
      onEvent: (event) => events.push(event),
    });

    expect(result.reason).toBe("awaiting_approval");
    expect(result.pendingApproval?.tool.name).toBe("set_window");
    expect(events.some((event) => event.type === "tool.approval_required")).toBe(true);
    // the tool must NOT have run
    expect(events.some((event) => event.type === "tool.call")).toBe(false);
  });

  it("runs a confirm-risk tool when the approval callback returns true", async () => {
    const provider = new ScriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "set_window", args: { action: "open" } }] },
      { text: "已打开车窗。", toolCalls: [] },
    ]);

    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("开车窗"),
      provider,
      tools,
      approval: () => true,
    });

    expect(result.reason).toBe("completed");
  });

  it("feeds invalid tool arguments back to the model instead of throwing", async () => {
    const provider = new ScriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "play", args: { trackId: 42 } }] },
      { text: "参数错了，我重试。", toolCalls: [] },
    ]);

    const events: AgentEvent[] = [];
    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("播放"),
      provider,
      tools,
      onEvent: (event) => events.push(event),
    });

    expect(result.reason).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.some((event) => event.type === "tool.call")).toBe(false);
  });

  it("treats an explicit denial as a tool error, not as a halt", async () => {
    const provider = new ScriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "set_window", args: { action: "open" } }] },
      { text: "抱歉，我没有权限打开车窗。", toolCalls: [] },
    ]);

    const events: AgentEvent[] = [];
    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("开车窗"),
      provider,
      tools,
      approval: () => false,
      onEvent: (event) => events.push(event),
    });

    // A host that answers "no" is different from a host that cannot ask yet.
    expect(result.reason).toBe("completed");
    expect(result.pendingApproval).toBeUndefined();
    expect(events.some((event) => event.type === "tool.call")).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(
      result.messages.some(
        (message) => message.role === "tool" && message.content.includes("denied"),
      ),
    ).toBe(true);
  });

  it("compacts the request while keeping the full recorded history", async () => {
    const bigResult = "x".repeat(20_000);
    const provider = new ScriptedProvider([{ text: "好的。", toolCalls: [] }]);

    const events: AgentEvent[] = [];
    const result = await runTurn({
      threadId: "thread_1",
      messages: [
        { role: "user", content: "读一下文件" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fs_read", args: { path: "a" } }] },
        { role: "tool", toolCallId: "c1", content: bigResult },
      ],
      provider,
      tools,
      context: { maxContextTokens: 200, toolResultMaxChars: 100, keepRecentToolResults: 0 },
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "context.compacted")).toBe(true);
    // history is untouched: only the request was shrunk
    expect(result.messages.some((message) => message.content === bigResult)).toBe(true);
  });

  it("reports the endpoint's token usage instead of estimating from characters", async () => {
    const provider = new ScriptedProvider([
      { text: "好", toolCalls: [], usage: { inputTokens: 9, outputTokens: 1 } },
    ]);

    const events: AgentEvent[] = [];
    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("hi"),
      provider,
      tools,
      onEvent: (event) => events.push(event),
    });

    // "hi" estimates to 1 token and the reply to 1; the endpoint says 9 / 1.
    expect(result.usage.inputTokens).toBe(9);
    expect(result.usage.outputTokens).toBe(1);
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      type: "usage",
      source: "api",
    });
  });

  it("falls back to estimates when the provider reports no usage", async () => {
    const provider = new ScriptedProvider([{ text: "好", toolCalls: [] }]);

    const events: AgentEvent[] = [];
    await runTurn({
      threadId: "thread_1",
      messages: userSays("hi"),
      provider,
      tools,
      onEvent: (event) => events.push(event),
    });

    expect(events.find((event) => event.type === "usage")).toMatchObject({
      type: "usage",
      source: "estimate",
    });
  });

  it("resumes a parked approval: approve executes the exact call and continues", async () => {
    const first = await runTurn({
      threadId: "thread_1",
      messages: userSays("开车窗"),
      provider: new ScriptedProvider([
        { text: "", toolCalls: [{ id: "c1", name: "set_window", args: { action: "open" } }] },
      ]),
      tools,
    });
    expect(first.reason).toBe("awaiting_approval");

    const events: AgentEvent[] = [];
    const second = await runTurn({
      threadId: "thread_1",
      turnId: first.turnId,
      messages: first.messages,
      provider: new ScriptedProvider([{ text: "已打开车窗。", toolCalls: [] }]),
      tools,
      resume: { callId: "c1", decision: "approve" },
      onEvent: (event) => events.push(event),
    });

    expect(second.reason).toBe("completed");
    expect(events.some((event) => event.type === "tool.approval_resolved")).toBe(true);
    expect(events.some((event) => event.type === "tool.call")).toBe(true);
    expect(
      second.messages.some((message) => message.role === "tool" && message.toolCallId === "c1"),
    ).toBe(true);
    // Same turn, continued — not a new one: no second turn.start.
    expect(second.turnId).toBe(first.turnId);
    expect(events.some((event) => event.type === "turn.start")).toBe(false);
  });

  it("resumes a parked approval: deny feeds an error back instead of executing", async () => {
    const first = await runTurn({
      threadId: "thread_1",
      messages: userSays("开车窗"),
      provider: new ScriptedProvider([
        { text: "", toolCalls: [{ id: "c1", name: "set_window", args: { action: "open" } }] },
      ]),
      tools,
    });

    const events: AgentEvent[] = [];
    const second = await runTurn({
      threadId: "thread_1",
      messages: first.messages,
      provider: new ScriptedProvider([{ text: "好的，不打开。", toolCalls: [] }]),
      tools,
      resume: { callId: "c1", decision: "deny" },
      onEvent: (event) => events.push(event),
    });

    expect(second.reason).toBe("completed");
    expect(events.some((event) => event.type === "tool.call")).toBe(false);
    expect(
      second.messages.some(
        (message) => message.role === "tool" && message.content.includes("denied"),
      ),
    ).toBe(true);
  });

  it("streams text deltas when the host asks for them, without duplicating the aggregate", async () => {
    const provider: ModelProvider = {
      id: "streamer",
      async complete() {
        return { text: "未使用", toolCalls: [] };
      },
      async stream(_req, onText) {
        for (const delta of ["你", "好"]) onText(delta);
        return { text: "你好", toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } };
      },
    };

    const events: AgentEvent[] = [];
    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("hi"),
      provider,
      tools,
      streaming: true,
      onEvent: (event) => events.push(event),
    });

    const deltas = events.filter((event) => event.type === "message.delta");
    expect(deltas.map((event) => (event.type === "message.delta" ? event.text : ""))).toEqual([
      "你",
      "好",
    ]);
    expect(
      events.some((event) => event.type === "message.complete" && event.text === "你好"),
    ).toBe(true);
    expect(result.usage.inputTokens).toBe(5);
  });

  it("uses the batch path when streaming was not requested", async () => {
    let streamed = false;
    const provider: ModelProvider = {
      id: "s",
      async complete() {
        return { text: "好", toolCalls: [] };
      },
      async stream() {
        streamed = true;
        return { text: "x", toolCalls: [] };
      },
    };

    const events: AgentEvent[] = [];
    await runTurn({
      threadId: "thread_1",
      messages: userSays("hi"),
      provider,
      tools,
      onEvent: (event) => events.push(event),
    });

    expect(streamed).toBe(false);
    expect(events.filter((event) => event.type === "message.delta")).toHaveLength(1);
  });

  it("fails loudly when asked to resume a call that is not pending", async () => {
    const events: AgentEvent[] = [];
    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("hi"),
      provider: new ScriptedProvider([{ text: "x", toolCalls: [] }]),
      tools,
      resume: { callId: "missing", decision: "approve" },
      onEvent: (event) => events.push(event),
    });

    expect(result.reason).toBe("error");
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("stops at maxSteps when the model never stops calling tools", async () => {
    const provider: ModelProvider = {
      id: "always-calls",
      async complete() {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "search_media", args: {} }],
        };
      },
    };

    const result = await runTurn({
      threadId: "thread_1",
      messages: userSays("loop"),
      provider,
      tools,
      maxSteps: 3,
    });

    expect(result.reason).toBe("max_steps");
    expect(result.usage.steps).toBe(3);
  });
});
