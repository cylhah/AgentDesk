import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentEventSchema,
  defineTool,
  estimateTokens,
  newId,
  TOOL_NAME_PATTERN,
} from "@agentdesk/protocol";

describe("AgentEventSchema", () => {
  it("accepts a well-formed tool.call event", () => {
    const event = {
      type: "tool.call",
      turnId: "turn_1",
      ts: 1,
      callId: "c1",
      name: "play",
      args: { trackId: "t-001" },
    };
    expect(AgentEventSchema.parse(event)).toMatchObject({ type: "tool.call", name: "play" });
  });

  it("rejects an unknown event type", () => {
    expect(() => AgentEventSchema.parse({ type: "nope", turnId: "t", ts: 0 })).toThrow();
  });

  it("rejects a turn.end with an invalid reason", () => {
    expect(() =>
      AgentEventSchema.parse({ type: "turn.end", turnId: "t", ts: 0, reason: "whatever" }),
    ).toThrow();
  });
});

describe("defineTool", () => {
  const base = {
    description: "test tool",
    risk: "safe" as const,
    parameters: z.object({}),
    run: async () => ({ ok: true, output: "" }),
  };

  it("rejects names the function-calling API cannot accept", () => {
    // DeepSeek/OpenAI both reject `fs.read` with HTTP 400 before the model ever sees it.
    expect(() => defineTool({ ...base, name: "fs.read" })).toThrow(/invalid tool name/);
  });

  it("accepts snake_case names", () => {
    expect(defineTool({ ...base, name: "fs_read" }).name).toBe("fs_read");
    expect(TOOL_NAME_PATTERN.test("shell_run")).toBe(true);
  });
});

describe("ids", () => {
  it("prefixes generated ids so traces stay greppable", () => {
    expect(newId("turn")).toMatch(/^turn_[0-9a-f-]{36}$/);
  });

  it("estimates tokens at roughly 4 chars per token", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
