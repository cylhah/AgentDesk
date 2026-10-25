import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "@agentdesk/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let repo = "";
const created: string[] = [];

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "agentdesk-gc-"));
  created.length = 0;
  await run("git", ["init"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "hello\n", "utf8");
  await run("git", ["add", "."], { cwd: repo });
  await run(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
    { cwd: repo },
  );
});

afterEach(async () => {
  for (const path of created) {
    try {
      await removeWorktree(repo, path);
    } catch {
      // already removed
    }
  }
  try {
    await run("git", ["worktree", "prune"], { cwd: repo });
  } catch {
    // repo may be gone
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(repo, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

describe("worktree lifecycle", () => {
  it("lists the main checkout and the agent worktrees", async () => {
    const worktree = await createWorktree({ repo, threadId: "thread_list" });
    created.push(worktree.path);

    const entries = await listWorktrees(repo);
    expect(entries.length).toBe(2);
    expect(entries[0]?.path).toBe(repo.replace(/\\/g, "/"));
    expect(entries.some((entry) => entry.path.endsWith("thread_list"))).toBe(true);
  });

  it("prunes only stale worktrees under the agent root", async () => {
    const stale = await createWorktree({ repo, threadId: "thread_stale" });
    created.push(stale.path);

    // olderThanMs = -1 means "everything is old enough".
    const removed = await pruneWorktrees({ repo, olderThanMs: -1 });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("thread_stale");
    expect((await listWorktrees(repo)).length).toBe(1);
  });

  it("keeps worktrees younger than the cutoff", async () => {
    const fresh = await createWorktree({ repo, threadId: "thread_fresh" });
    created.push(fresh.path);

    const removed = await pruneWorktrees({ repo, olderThanMs: 60_000 });
    expect(removed).toEqual([]);
    expect((await listWorktrees(repo)).some((entry) => entry.path.endsWith("thread_fresh"))).toBe(
      true,
    );
  });
});
