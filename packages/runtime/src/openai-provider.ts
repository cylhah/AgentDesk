import type { Message, ToolSpec } from "@agentdesk/protocol";
import type { AssistantTurn, CompletionRequest, ModelProvider } from "./provider";

export interface OpenAIProviderConfig {
  readonly apiKey: string;
  /** Any OpenAI-compatible endpoint: OpenAI, DeepSeek, vLLM, Ollama, ... */
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
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
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = config.model ?? "gpt-4o-mini";
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.apiKey = config.apiKey;
    this.id = `openai:${this.model}`;
  }

  private readonly apiKey: string;

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(req.messages, req.system),
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
  });
}
