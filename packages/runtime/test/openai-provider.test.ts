import { OpenAIProvider, toWireMessages } from "@agentdesk/runtime";
import { describe, expect, it } from "vitest";

const ok = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("toWireMessages", () => {
  it("maps assistant tool calls and tool results to the OpenAI wire format", () => {
    const wire = toWireMessages(
      [
        { role: "user", content: "play something" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "play", args: { trackId: "t-001" } }],
        },
        { role: "tool", toolCallId: "call_1", content: "ok" },
      ],
      "you are a media agent",
    );

    expect(wire[0]).toEqual({ role: "system", content: "you are a media agent" });
    expect(wire[2]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "play", arguments: '{"trackId":"t-001"}' },
        },
      ],
    });
    expect(wire[3]).toEqual({ role: "tool", content: "ok", tool_call_id: "call_1" });
  });
});

describe("OpenAIProvider", () => {
  it("parses tool calls out of a completion", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return ok({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "play", arguments: '{"trackId":"t-001"}' } },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({
      apiKey: "test",
      baseUrl: "https://example.test/v1/",
      model: "test-model",
      fetchImpl: fakeFetch,
    });

    const turn = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "play", description: "play a track", parameters: { type: "object" } }],
    });

    expect(turn.toolCalls).toEqual([
      { id: "call_1", name: "play", args: { trackId: "t-001" } },
    ]);
    expect(seen[0]?.url).toBe("https://example.test/v1/chat/completions");
    expect(seen[0]?.body.model).toBe("test-model");
    expect(seen[0]?.body.tool_choice).toBe("auto");
  });

  it("retries on 5xx and succeeds on the next attempt", async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("upstream boom", { status: 503 });
      }
      return ok({ choices: [{ message: { content: "done" } }] });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({
      apiKey: "test",
      model: "m",
      maxRetries: 2,
      fetchImpl: fakeFetch,
    });

    const turn = await provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(turn.text).toBe("done");
    expect(attempts).toBe(2);
  });

  it("does not retry on 401", async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts += 1;
      return new Response("bad key", { status: 401 });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ apiKey: "test", model: "m", fetchImpl: fakeFetch });

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [] }),
    ).rejects.toThrow(/401/);
    expect(attempts).toBe(1);
  });

  it("treats unparseable argument JSON as invalid so zod can reject it", async () => {
    const fakeFetch = (async () =>
      ok({
        choices: [
          {
            message: {
              tool_calls: [{ id: "call_1", function: { name: "play", arguments: "{not json" } }],
            },
          },
        ],
      })) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ apiKey: "test", model: "m", fetchImpl: fakeFetch });
    const turn = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    expect(turn.toolCalls[0]?.args).toBeUndefined();
  });
});
