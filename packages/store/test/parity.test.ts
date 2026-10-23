import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@agentdesk/protocol";
import {
  JsonlSessionStore,
  SqliteSessionStore,
  type SessionStore,
} from "@agentdesk/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdesk-parity-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const conversation: Message[] = [
  { role: "user", content: "放周杰伦的晴天" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "play", args: { trackId: "t-001" } }],
  },
  { role: "tool", toolCallId: "c1", content: '{"nowPlaying":"晴天"}' },
  { role: "assistant", content: "正在播放《晴天》。" },
];

const implementations: [string, () => SessionStore][] = [
  ["jsonl", () => new JsonlSessionStore(join(dir, "sessions"))],
  ["sqlite", () => new SqliteSessionStore(join(dir, "sessions.db"))],
];

/**
 * Same contract, both implementations. If these diverge, `--resume` silently
 * changes behaviour depending on a storage flag — the worst kind of bug.
 */
describe.each(implementations)("%s store", (_kind, open) => {
  let store: SessionStore;

  beforeEach(() => {
    store = open();
  });

  afterEach(() => {
    store.close();
  });

  it("round-trips messages in order, including tool calls", async () => {
    await store.create({
      threadId: "thread_a",
      cwd: dir,
      provider: "openai:deepseek-chat",
      system: "policy-v1",
      now: 1_700_000_000_000,
    });
    for (const message of conversation) {
      await store.appendMessage("thread_a", "turn_1", message);
    }
    await store.appendTurn("thread_a", {
      turnId: "turn_1",
      reason: "completed",
      usage: { inputTokens: 42, outputTokens: 7, steps: 2 },
    });

    const loaded = await store.load("thread_a");

    expect(loaded.messages).toEqual(conversation);
    expect(loaded.header.system).toBe("policy-v1");
    expect(loaded.header.provider).toBe("openai:deepseek-chat");
    expect(loaded.header.createdAt).toBe(1_700_000_000_000);
    expect(loaded.turns).toHaveLength(1);
    expect(loaded.turns[0]?.reason).toBe("completed");
    expect(loaded.turns[0]?.usage).toEqual({ inputTokens: 42, outputTokens: 7, steps: 2 });
  });

  it("replays the policy the session was recorded with, not today's default", async () => {
    await store.create({ threadId: "thread_b", cwd: dir, provider: "p", system: "old-policy" });
    await store.appendMessage("thread_b", "turn_1", { role: "user", content: "hi" });

    const loaded = await store.load("thread_b");
    expect(loaded.header.system).toBe("old-policy");
  });

  it("lists sessions newest first with a first-user preview", async () => {
    await store.create({ threadId: "thread_old", cwd: dir, provider: "p" });
    await store.appendMessage("thread_old", "turn_1", { role: "user", content: "旧会话" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.create({ threadId: "thread_new", cwd: dir, provider: "p" });
    await store.appendMessage("thread_new", "turn_1", { role: "user", content: "新会话" });

    const sessions = await store.list();
    expect(sessions.map((session) => session.threadId)).toEqual(["thread_new", "thread_old"]);
    expect(sessions[0]?.firstUserText).toBe("新会话");
    expect(sessions[1]?.messages).toBe(1);
    expect(sessions[0]?.provider).toBe("p");
  });

  it("fails loudly on an unknown thread", async () => {
    await expect(store.load("thread_missing")).rejects.toThrow(/no such session/);
  });

  it("keeps one summary per thread, latest wins", async () => {
    await store.create({ threadId: "thread_s", cwd: dir, provider: "p" });
    await store.appendMessage("thread_s", "turn_1", { role: "user", content: "hi" });

    await store.saveSummary("thread_s", { text: "第一版摘要", frontier: 2 });
    await store.saveSummary("thread_s", { text: "第二版摘要", frontier: 4 });

    const loaded = await store.load("thread_s");
    expect(loaded.summary).toEqual({ text: "第二版摘要", frontier: 4 });
    // The messages themselves are untouched by summarisation.
    expect(loaded.messages).toHaveLength(1);
  });
});

describe("sqlite store", () => {
  it("survives a process restart: reopening the file sees the same session", async () => {
    const file = join(dir, "sessions.db");
    const first = new SqliteSessionStore(file);
    await first.create({ threadId: "thread_p", cwd: dir, provider: "p", system: "policy" });
    await first.appendMessage("thread_p", "turn_1", { role: "user", content: "还在吗" });
    first.close();

    const second = new SqliteSessionStore(file);
    try {
      const loaded = await second.load("thread_p");
      expect(loaded.messages).toEqual([{ role: "user", content: "还在吗" }]);
      expect(loaded.header.system).toBe("policy");
    } finally {
      second.close();
    }
  });

  it("refuses thread ids that could escape the session namespace", async () => {
    const store = new SqliteSessionStore(join(dir, "sessions.db"));
    try {
      await expect(
        store.create({ threadId: "../escape", cwd: dir, provider: "p" }),
      ).rejects.toThrow(/invalid threadId/);
    } finally {
      store.close();
    }
  });
});
