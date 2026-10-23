import type { Message } from "@agentdesk/protocol";
import type { ModelProvider, ModelUsage } from "./provider";

/**
 * Compress old turns into one paragraph, so the request window shrinks without
 * throwing the earlier context away.
 *
 * Division of labour with `compactMessages`:
 *   - summarise = semantic (what happened, what is still open)
 *   - compact   = structural (truncate / elide / drop whole turns)
 * Summarisation costs one extra request, so it runs only when the request is
 * already large; the structural pass stays as the cheap fallback.
 *
 * The returned usage is reported back to the loop: a summary is not free, and
 * hiding its cost would make the before/after table lie.
 */
export interface SummaryOutput {
  readonly text: string;
  readonly usage?: ModelUsage;
}

export type Summarizer = (messages: readonly Message[]) => Promise<SummaryOutput>;

/** Per-message cap inside the transcript we feed the summarizer. */
const TRANSCRIPT_MESSAGE_CHARS = 800;

export function toTranscript(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      const body =
        message.content.length > TRANSCRIPT_MESSAGE_CHARS
          ? `${message.content.slice(0, TRANSCRIPT_MESSAGE_CHARS)}…`
          : message.content;
      if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
        const calls = message.toolCalls
          ?.map((call) => `${call.name}(${JSON.stringify(call.args)})`)
          .join(", ");
        return `[assistant → 调用工具] ${calls}${body.length > 0 ? `\n${body}` : ""}`;
      }
      if (message.role === "tool") {
        return `[工具结果] ${body}`;
      }
      return `[${message.role}] ${body}`;
    })
    .join("\n");
}

const SUMMARY_SYSTEM = `你负责压缩 agent 的会话历史，供后续步骤继续使用。

要求：
1. 保留：用户的原始意图、已经完成的动作与结果、关键事实（id、数量、结论）、未完成事项、用户给出的约束。
2. 丢弃：寒暄、重复表达、工具调用的原始 JSON（只说结论）。
3. 用中文，不超过 200 字，只输出摘要正文，不要加前缀或解释。`;

/** Summariser backed by the same provider — one extra request, same model. */
export function makeProviderSummarizer(provider: ModelProvider): Summarizer {
  return async (messages) => {
    const turn = await provider.complete({
      messages: [{ role: "user", content: toTranscript(messages) }],
      tools: [],
      system: SUMMARY_SYSTEM,
    });
    return {
      text: turn.text.trim(),
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    };
  };
}

/**
 * Splits at a user-message boundary so the kept tail starts a conversation turn
 * rather than in the middle of a tool call/result pair.
 */
export function splitForSummary(
  messages: readonly Message[],
  keepRecentTurns: number,
): { head: readonly Message[]; tail: readonly Message[] } {
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);

  if (userIndexes.length <= keepRecentTurns) {
    return { head: [], tail: messages };
  }
  const splitAt = userIndexes[userIndexes.length - keepRecentTurns] ?? 0;
  return { head: messages.slice(0, splitAt), tail: messages.slice(splitAt) };
}

export function summaryMessage(text: string): Message {
  return {
    role: "user",
    content: `[早前对话摘要，非用户原话]\n${text}`,
  };
}
