import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalHistory } from "@agentdesk/eval";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir = "";
let history: EvalHistory;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdesk-eval-"));
  history = new EvalHistory(join(dir, "eval-history.ndjson"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (ok: boolean, tokens: number, durations: number[]) => ({
  model: "openai:deepseek-chat",
  scenario: "media",
  live: true,
  flags: {},
  cases: durations.map((durationMs, index) => ({
    id: `case-${index}`,
    ok,
    reason: "completed",
    steps: 1,
    inputTokens: tokens,
    outputTokens: 0,
    durationMs,
    failures: [],
  })),
});

describe("EvalHistory", () => {
  it("summarises pass rate, cost and p50 latency on append", async () => {
    const record = await history.append(run(true, 1000, [100, 300, 200]));

    expect(record.summary.total).toBe(3);
    expect(record.summary.passed).toBe(3);
    expect(record.summary.inputTokens).toBe(3000);
    expect(record.summary.p50Ms).toBe(200);
    expect(record.v).toBe(1);
    expect(record.ts).toBeGreaterThan(0);
  });

  it("keeps history append-only across runs, newest last", async () => {
    await history.append({ ...run(true, 100, [10]), ts: 1_700_000_000_000 });
    await history.append({ ...run(false, 200, [20]), ts: 1_700_000_100_000 });

    const runs = await history.read();
    expect(runs).toHaveLength(2);
    expect(runs[1]?.ts).toBe(1_700_000_100_000);
    expect(runs[1]?.summary.passed).toBe(0);
  });

  it("returns the last N runs", async () => {
    for (let index = 0; index < 5; index += 1) {
      await history.append(run(true, index, [index]));
    }
    const runs = await history.read(2);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.summary.inputTokens).toBe(4);
  });

  it("ignores a torn last line instead of losing earlier runs", async () => {
    await history.append(run(true, 100, [10]));
    await appendFile(history.file, '{"v":1,"ts":2,"model":"half', "utf8");

    const runs = await history.read();
    expect(runs).toHaveLength(1);
  });

  it("returns an empty list before anything is recorded", async () => {
    expect(await history.read()).toEqual([]);
  });
});
