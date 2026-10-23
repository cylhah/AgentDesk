import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@agentdesk/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir = "";
let audit: AuditLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdesk-audit-"));
  audit = new AuditLog(join(dir, "audit.ndjson"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AuditLog", () => {
  it("records a decision trail with tool, risk and workspace", async () => {
    await audit.record({
      threadId: "thread_a",
      turnId: "turn_1",
      kind: "tool",
      cwd: "C:/work/wt/thread_a",
      tool: "set_window",
      risk: "confirm",
      decision: "approved",
      ok: true,
      durationMs: 3,
      args: '{"action":"open"}',
    });

    const entries = await audit.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      threadId: "thread_a",
      tool: "set_window",
      decision: "approved",
      cwd: "C:/work/wt/thread_a",
    });
    expect(entries[0]?.ts).toBeGreaterThan(0);
  });

  it("filters by thread and keeps only the last N entries", async () => {
    for (const threadId of ["thread_a", "thread_b", "thread_a"]) {
      await audit.record({ threadId, kind: "turn", reason: "completed" });
    }

    expect(await audit.read({ threadId: "thread_a" })).toHaveLength(2);
    expect(await audit.read({ limit: 2 })).toHaveLength(2);
    expect((await audit.read({ threadId: "thread_b" }))[0]?.threadId).toBe("thread_b");
  });

  it("returns an empty trail when nothing was recorded yet", async () => {
    expect(await audit.read()).toEqual([]);
  });
});
