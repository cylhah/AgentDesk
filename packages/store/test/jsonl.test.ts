import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@agentdesk/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir = "";
let store: JsonlSessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdesk-store-"));
  store = new JsonlSessionStore(join(dir, "sessions"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const openSession = async (threadId = "thread_abc") =>
  await store.create({
    threadId,
    cwd: dir,
    provider: "openai:deepseek-chat",
    system: "policy-v1",
    now: 1700000000000,
  });

describe("JsonlSessionStore", () => {
  it("round-trips messages in order and keeps the policy it was created with", async () => {
    const header = await openSession();
    expect(header.system).toBe("policy-v1");

    await store.appendMessage("thread_abc", "turn_1", { role: "user", content: "放晴天" });
    await store.appendMessage("thread_abc", "turn_1", {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "play", args: { trackId: "t-001" } }],
    });
    await store.appendMessage("thread_abc", "turn_1", {
      role: "tool",
      content: '{"nowPlaying":"晴天"}',
      toolCallId: "c1",
    });
    await store.appendTurn("thread_abc", {
      turnId: "turn_1",
      reason: "completed",
      usage: { inputTokens: 10, outputTokens: 2, steps: 2 },
    });

    const loaded = await store.load("thread_abc");

    expect(loaded.skippedLines).toBe(0);
    expect(loaded.header.system).toBe("policy-v1");
    expect(loaded.header.provider).toBe("openai:deepseek-chat");
    expect(loaded.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(loaded.messages[1]?.toolCalls?.[0]?.name).toBe("play");
    expect(loaded.turns).toHaveLength(1);
    expect(loaded.turns[0]?.usage.inputTokens).toBe(10);
  });

  it("survives a torn line: bad JSON is skipped, everything else is kept", async () => {
    await openSession();
    await store.appendMessage("thread_abc", "turn_1", { role: "user", content: "第一句" });

    // Simulate a crash mid-write.
    await appendFile(store.fileFor("thread_abc"), '{"v":1,"type":"message","message":{"rol', "utf8");

    await store.appendMessage("thread_abc", "turn_1", { role: "assistant", content: "回复" });

    const loaded = await store.load("thread_abc");
    expect(loaded.skippedLines).toBe(1);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1]?.content).toBe("回复");
  });

  it("is append-only NDJSON, one line per record", async () => {
    await openSession();
    await store.appendMessage("thread_abc", "turn_1", { role: "user", content: "hi" });

    const raw = await readFile(store.fileFor("thread_abc"), "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("summarises sessions newest first", async () => {
    await openSession("thread_one");
    await store.appendMessage("thread_one", "turn_1", { role: "user", content: "放晴天" });
    await openSession("thread_two");
    await store.appendMessage("thread_two", "turn_1", { role: "user", content: "打开车窗" });

    const sessions = await store.list();
    expect(sessions).toHaveLength(2);
    const byId = new Map(sessions.map((session) => [session.threadId, session]));
    expect(byId.get("thread_one")?.firstUserText).toBe("放晴天");
    expect(byId.get("thread_two")?.provider).toBe("openai:deepseek-chat");
  });

  it("refuses thread ids that could escape the session directory", async () => {
    expect(() => store.fileFor("../escape")).toThrow(/invalid threadId/);
    expect(() => store.fileFor("a/b")).toThrow(/invalid threadId/);
  });

  it("fails loudly when asked to load a session that does not exist", async () => {
    await expect(store.load("thread_missing")).rejects.toThrow(/no such session/);
  });
});
