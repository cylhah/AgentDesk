import type { Message, ToolSpec } from "@agentdesk/protocol";
import type { AssistantTurn, CompletionRequest, ModelProvider } from "./provider";

export interface OpenAIProviderConfig {
  readonly apiKey: string;
  /** Any OpenAI-compatible endpoint: OpenAI, DeepSeek, vLLM, Ollama, ... */
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /**
   * Explicit sampling temperature. Left undefined => endpoint default (1.0 for
   * DeepSeek/OpenAI), which makes "same prompt, different tool calls" normal.
   * Eval runs set 0 so a regression means a code change, not a coin flip.
   */
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Yields the decoded JSON payload of each SSE `data:` line.
 *
 * Chunks split anywhere — mid-event, mid-JSON, between `\r\n` and `\n` — so the
 * buffer is only consumed on a blank line. `[DONE]` ends the stream; malformed
 * frames are skipped (a keep-alive comment must not kill the turn).
 */
async function* readSsePayloads(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice("data:".length).trim();
          if (data === "[DONE]") return;
          if (data.length === 0) continue;
          try {
            yield JSON.parse(data) as unknown;
          } catch {
            // keep-alive or a partial frame; ignore
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function toWireMessages(
  messages: readonly Message[],
  system?: string,
): WireMessage[] {
  const wire: WireMessage[] = [];
  if (system !== undefined && system.length > 0) {
    wire.push({ role: "system", content: system });
  }
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      wire.push({
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      });
      continue;
    }
    if (message.role === "tool") {
      wire.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "",
      });
      continue;
    }
    wire.push({ role: message.role, content: message.content });
  }
  return wire;
}

export function toWireTools(
  tools: readonly ToolSpec[],
): { type: "function"; function: ToolSpec }[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseArgs(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Leave it undefined so zod rejects it and the loop feeds a readable
    // validation error back to the model.
    return undefined;
  }
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly temperature: number | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = config.model ?? "gpt-4o-mini";
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.temperature = config.temperature;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.apiKey = config.apiKey;
    this.id = `openai:${this.model}`;
  }

  private readonly apiKey: string;

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(req.messages, req.system),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    };
    if (req.tools.length > 0) {
      body.tools = toWireTools(req.tools);
      body.tool_choice = "auto";
    }

    const payload = await this.request<ChatCompletionResponse>("/chat/completions", body);
    const message = payload.choices?.[0]?.message;
    const text = message?.content ?? "";
    const toolCalls = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      args: parseArgs(call.function.arguments),
    }));

    const usage = payload.usage;
    return {
      text,
      toolCalls,
      ...(usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined
        ? {
            usage: {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            },
          }
        : {}),
    };
  }

  /**
   * Streaming variant. Text arrives as deltas (`onText`), tool calls arrive as
   * fragments that have to be reassembled by `index` — a tool call's JSON
   * arguments are split across chunks at arbitrary character boundaries.
   *
   * No retry here on purpose: once bytes have been shown to the user, silently
   * retrying would duplicate text. A mid-stream failure is surfaced as an error
   * and the turn can be re-run deliberately.
   */
  async stream(
    req: CompletionRequest,
    onText: (delta: string) => void,
  ): Promise<AssistantTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(req.messages, req.system),
      stream: true,
      stream_options: { include_usage: true },
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    };
    if (req.tools.length > 0) {
      body.tools = toWireTools(req.tools);
      body.tool_choice = "auto";
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      throw new Error(`upstream ${response.status}: ${detail}`);
    }
    if (response.body === null) {
      throw new Error("streaming response has no body");
    }

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    for await (const payload of readSsePayloads(response.body)) {
      const parsed = payload as {
        choices?: {
          delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      // DeepSeek/OpenAI send the usage chunk last, with an empty `choices`.
      if (parsed.usage !== undefined) usage = parsed.usage;

      for (const choice of parsed.choices ?? []) {
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const call of delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = calls.get(index) ?? { id: "", name: "", args: "" };
          calls.set(index, {
            id: call.id ?? current.id,
            name: call.function?.name ?? current.name,
            args: current.args + (call.function?.arguments ?? ""),
          });
        }
      }
    }

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, name: call.name, args: parseArgs(call.args) }));

    return {
      text,
      toolCalls,
      ...(usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined
        ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
        : {}),
    };
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    let lastError: Error = new Error("request failed before it started");

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // Network failure or timeout: worth one more try.
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) await sleep(300 * 2 ** attempt);
        continue;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      const detail = (await response.text()).slice(0, 400);
      const error = new Error(`upstream ${response.status}: ${detail}`);
      // 4xx (other than rate limit) is our fault — retrying cannot help.
      if (response.status !== 429 && response.status < 500) throw error;

      lastError = error;
      if (attempt < this.maxRetries) await sleep(300 * 2 ** attempt);
    }

    throw lastError;
  }
}

/** Reads `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` (DeepSeek key also accepted). */
export function openAIProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIProvider {
  const apiKey = env.OPENAI_API_KEY ?? env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      "missing OPENAI_API_KEY (or DEEPSEEK_API_KEY) — export it, or run with --mock",
    );
  }
  return new OpenAIProvider({
    apiKey,
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL,
    // Set OPENAI_TEMPERATURE=0 for repeatable eval runs; unset keeps the
    // endpoint default, which is what interactive use wants.
    ...(env.OPENAI_TEMPERATURE !== undefined &&
    Number.isFinite(Number(env.OPENAI_TEMPERATURE))
      ? { temperature: Number(env.OPENAI_TEMPERATURE) }
      : {}),
  });
}
