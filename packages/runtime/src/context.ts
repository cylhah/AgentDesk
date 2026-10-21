import { estimateTokens, type Message } from "@agentdesk/protocol";

/**
 * Deterministic context management. Three escalating stages, cheapest first:
 *
 *   1. truncate  — cap each old tool result (the biggest, least reusable payloads)
 *   2. elide     — replace an old tool result with a one-line stub
 *   3. drop      — remove whole old turns, never half of one
 *
 * Deliberately *not* summarisation: that needs a model call, costs money and is
 * non-deterministic, so it belongs in Week 3 where it can be measured. Until
 * then the rule is "lose precision before losing structure".
 *
 * Invariant that matters: an `assistant` message carrying `toolCalls` is only
 * ever dropped together with its `tool` results — otherwise the next request is
 * rejected by the API for having a tool call with no tool message.
 */
export interface CompactionOptions {
  /** Budget for the request only; the full history stays on disk. */
  readonly maxContextTokens?: number;
  readonly toolResultMaxChars?: number;
  /** Keep the most recent N tool results verbatim — they are what the next step reasons about. */
  readonly keepRecentToolResults?: number;
}

export interface CompactionReport {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly truncatedToolResults: number;
  readonly elidedToolResults: number;
  readonly droppedMessages: number;
  readonly changed: boolean;
}

export const DEFAULT_CONTEXT_TOKENS = 32_000;
export const DEFAULT_TOOL_RESULT_CHARS = 2_000;

const ELIDED_PREFIX = "[elided";
const TRUNCATED_MARK = "… (truncated, ";

function countTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

export function compactMessages(
  messages: readonly Message[],
  options: CompactionOptions = {},
): { messages: Message[]; report: CompactionReport } {
  const maxTokens = options.maxContextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const maxChars = options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_CHARS;
  const keepRecent = options.keepRecentToolResults ?? 4;

  const tokensBefore = countTokens(messages);
  let out: Message[] = messages.map((message) => ({ ...message }));
  const toolIndexes = out
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  // `slice(-0)` is `slice(0)`, which would protect everything: guard explicitly.
  const recentTools = new Set(
    keepRecent <= 0 ? [] : toolIndexes.slice(-keepRecent),
  );

  let truncatedToolResults = 0;
  for (const index of toolIndexes) {
    if (recentTools.has(index)) continue;
    const message = out[index];
    if (message === undefined || message.content.length <= maxChars) continue;
    if (message.content.includes(TRUNCATED_MARK)) continue; // already compressed once
    out[index] = {
      ...message,
      content: `${message.content.slice(0, maxChars)}\n${TRUNCATED_MARK}${message.content.length} chars total)`,
    };
    truncatedToolResults += 1;
  }

  let elidedToolResults = 0;
  if (countTokens(out) > maxTokens) {
    for (const index of toolIndexes) {
      if (recentTools.has(index)) continue;
      const message = out[index];
      if (message === undefined || message.content.startsWith(ELIDED_PREFIX)) continue;
      out[index] = {
        ...message,
        content: `${ELIDED_PREFIX}: tool output, ${message.content.length} chars]`,
      };
      elidedToolResults += 1;
      if (countTokens(out) <= maxTokens) break;
    }
  }

  let droppedMessages = 0;
  while (countTokens(out) > maxTokens) {
    // Skip a leading block that is not a user turn (e.g. a resumed conversation
    // starting mid-turn), then cut at the next user message.
    const firstUser = out.findIndex((message) => message.role === "user");
    const nextUser =
      firstUser < 0
        ? -1
        : out.findIndex((message, index) => index > firstUser && message.role === "user");
    if (nextUser <= 0) break; // nothing safe left to drop
    out = out.slice(nextUser);
    droppedMessages += nextUser;
  }

  const tokensAfter = countTokens(out);
  return {
    messages: out,
    report: {
      tokensBefore,
      tokensAfter,
      truncatedToolResults,
      elidedToolResults,
      droppedMessages,
      changed:
        truncatedToolResults > 0 || elidedToolResults > 0 || droppedMessages > 0,
    },
  };
}
