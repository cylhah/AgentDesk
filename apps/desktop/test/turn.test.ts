import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@agentdesk/protocol";
import { EventBroker } from "@agentdesk/eventstream";
import type { ModelProvider } from "@agentdesk/runtime";
import { JsonlSessionStore } from "@agentdesk/store";
import { mediaScenario } from "@agentdesk/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnRunner } from "../src/turn";

let dir = "";
let store: JsonlSessionStore;
let broker: EventBroker;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdesk-turn-"));
  store = new JsonlSessionStore(join(dir, "sessions"));
  broker = new EventBroker();
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const textProvider = (): ModelProvider => ({
  id: "fake",
  async complete() {
    return { text: "好的。", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  },
});

const runner = (provider: ModelProvider = textProvider()): TurnRunner =>
  new TurnRunner({ store, broker, scenario: mediaScenario, cwd: dir, provider });

describe("TurnRunner threading", () => {
  it("keeps consecutive tasks in one thread instead of creating a session per task", async () => {
    const turn = runner();

    const first = await turn.start("放首歌");
    const second = await turn.start("换一首");
    const third = await turn.start("再来一首");

    // The bug this guards: every task used to open a new thread, so one
    // conversation showed up as N one-turn sessions in the sidebar.
    expect(second.threadId).toBe(first.threadId);
    expect(third.threadId).toBe(first.threadId);

    const sessions = await store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.turns).toBe(3);
    expect(sessions[0]?.messages).toBeGreaterThanOrEqual(6); // 3 user + 3 assistant
  });

  it("starts a new thread only when asked", async () => {
    const turn = runner();
    const first = await turn.start("放首歌");
    turn.newSession();
    const second = await turn.start("打开车窗");

    expect(second.threadId).not.toBe(first.threadId);
    expect(await store.list()).toHaveLength(2);
  });

  it("refuses a new task while a turn is parked for approval", async () => {
    let calls = 0;
    const parked: ModelProvider = {
      id: "fake",
      async complete() {
        calls += 1;
        // Ask for the window once, then answer normally after the decision.
        if (calls === 1) {
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "set_window", args: { action: "open" } }],
          };
        }
        return { text: "好的，不打开。", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const turn = runner(parked);

    const state = await turn.start("把车窗打开");
    expect(state.pending).toHaveLength(1);
    await expect(turn.start("另一件事")).rejects.toThrow(/already in progress/);

    // Settling the same turn continues it rather than re-running.
    const resumed = await turn.resolve([{ callId: state.pending[0]!.callId, decision: "deny" }]);
    expect(resumed.reason).toBe("completed");
  });

  it("records every turn of a thread in the event trace", async () => {
    const events: AgentEvent[] = [];
    broker.subscribe((frame) => events.push(frame.event));

    const turn = runner();
    await turn.start("放首歌");
    await turn.start("换一首");

    const started = events.filter((event) => event.type === "turn.start");
    expect(started).toHaveLength(2);
    const threadIds = new Set(started.map((event) => (event.type === "turn.start" ? event.turnId : "")));
    expect(threadIds.size).toBe(2); // two turns, two ids
  });
});
