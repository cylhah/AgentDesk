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
