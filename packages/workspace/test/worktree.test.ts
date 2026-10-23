import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, isGitRepo, removeWorktree } from "@agentdesk/workspace";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let repo = "";
const created: string[] = [];

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "agentdesk-wt-"));
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
  // Unregister worktrees before deleting the repo: a dangling git lock makes the
  // next run flaky, and `rm -rf` on a repo with live worktrees leaves noise.
  for (const path of created) {
    try {
      await removeWorktree(repo, path);
    } catch {
      // already removed by the test itself
    }
  }
  try {
    await run("git", ["worktree", "prune"], { cwd: repo });
  } catch {
    // repo may be gone
  }
  await rm(repo, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("creates an isolated checkout that starts from the current commit", async () => {
    const worktree = await createWorktree({ repo, threadId: "thread_a" });
    created.push(worktree.path);

    const content = (await readFile(join(worktree.path, "README.md"), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    expect(content).toBe("hello\n");
    expect(worktree.path.endsWith(join("runs", "worktrees", "thread_a"))).toBe(true);
  });

  it("keeps agent writes out of the user's checkout", async () => {
    const worktree = await createWorktree({ repo, threadId: "thread_b" });
    created.push(worktree.path);
    await writeFile(join(worktree.path, "agent.txt"), "written by the agent\n", "utf8");

    // The main working tree must not see the new file.
    await expect(readFile(join(repo, "agent.txt"), "utf8")).rejects.toThrow();
  });

  it("removes the worktree on demand", async () => {
    const worktree = await createWorktree({ repo, threadId: "thread_c" });
    created.push(worktree.path);
    await removeWorktree(repo, worktree.path);
    await expect(readFile(join(worktree.path, "README.md"), "utf8")).rejects.toThrow();
  });

  it("refuses ids that could escape the worktree root", async () => {
    await expect(createWorktree({ repo, threadId: "../escape" })).rejects.toThrow(
      /invalid threadId/,
    );
  });

  it("reports whether a directory is a git repository", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(tmpdir())).toBe(false);
  });
});
