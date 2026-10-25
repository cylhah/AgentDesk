import { OpenAIProvider } from "@agentdesk/runtime";
import { describe, expect, it } from "vitest";

/** Builds a Response whose body emits the given chunks exactly as written. */
function streamResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const provider = (chunks: readonly string[], status = 200): OpenAIProvider =>
  new OpenAIProvider({
    apiKey: "test",
    model: "m",
    fetchImpl: (async () =>
      status === 200 ? streamResponse(chunks) : new Response("boom", { status })) as unknown as typeof fetch,
  });

describe("OpenAIProvider.stream", () => {
  it("emits text deltas and reassembles the full text", async () => {
    const deltas: string[] = [];
    const turn = await provider([
      sse({ choices: [{ delta: { content: "正在" } }] }),
      sse({ choices: [{ delta: { content: "为你" } }] }),
      sse({ choices: [{ delta: { content: "播放。" } }] }),
      "data: [DONE]\n\n",
    ]).stream({ messages: [{ role: "user", content: "放歌" }], tools: [] }, (delta) =>
      deltas.push(delta),
    );

    expect(deltas).toEqual(["正在", "为你", "播放。"]);
    expect(turn.text).toBe("正在为你播放。");
    expect(turn.toolCalls).toEqual([]);
  });

  it("reassembles tool calls whose JSON arguments are split mid-string", async () => {
    // This is the part that breaks naive parsers: arguments arrive as fragments.
    const turn = await provider([
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "play", arguments: '{"track' } },
              ],
            },
          },
        ],
      }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"t-0' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '01"}' } }] } }] }),
      sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ]).stream({ messages: [{ role: "user", content: "放晴天" }], tools: [] }, () => undefined);

    expect(turn.toolCalls).toEqual([{ id: "c1", name: "play", args: { trackId: "t-001" } }]);
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it("keeps parallel tool calls apart by index", async () => {
    const turn = await provider([
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "search_media", arguments: '{"query":"晴天"}' } },
                { index: 1, id: "b", function: { name: "get_now_playing", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ]).stream({ messages: [{ role: "user", content: "x" }], tools: [] }, () => undefined);

    expect(turn.toolCalls.map((call) => call.name)).toEqual(["search_media", "get_now_playing"]);
  });

  it("survives events split across chunk boundaries and CRLF framing", async () => {
    const whole = `data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"的"}}]}\r\n\r\n`;
    // Cut in the middle of the second event's JSON.
    const cut = 40;
    const deltas: string[] = [];
    const turn = await provider([whole.slice(0, cut), whole.slice(cut)]).stream(
      { messages: [{ role: "user", content: "x" }], tools: [] },
      (delta) => deltas.push(delta),
    );

    expect(turn.text).toBe("好的");
    expect(deltas).toEqual(["好", "的"]);
  });

  it("throws on a non-2xx stream instead of pretending the turn is empty", async () => {
    await expect(
      provider([], 500).stream({ messages: [{ role: "user", content: "x" }], tools: [] }, () => undefined),
    ).rejects.toThrow(/upstream 500/);
  });
});
