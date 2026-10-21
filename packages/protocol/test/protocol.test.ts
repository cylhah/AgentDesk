import { describe, expect, it } from "vitest";
import { AgentEventSchema, estimateTokens, newId } from "@agentdesk/protocol";

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
