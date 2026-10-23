import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ID = /^[a-zA-Z0-9_-]{1,64}$/;

export interface CreateWorktreeInput {
  /** The git repository to branch from. */
  readonly repo: string;
  /** Thread id; becomes the directory name. */
  readonly threadId: string;
  /** Where worktrees live. Defaults to `<repo>/runs/worktrees`. */
  readonly root?: string;
}

export interface Worktree {
  readonly path: string;
  readonly repo: string;
}

/**
 * One git worktree per session.
 *
 * `resolveInside` (a string-prefix check) is the first gate; it stops accidents,
 * not a determined model — symlinks, `..` through an existing link, or a
 * concurrent writer all slip past it. A worktree is the OS-level boundary that
 * costs nothing to create and can be thrown away: the agent can wreck it and the
 * user's real checkout is untouched.
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
  if (!ID.test(input.threadId)) {
    throw new Error(`invalid threadId: ${JSON.stringify(input.threadId)}`);
  }
  const repo = resolve(input.repo);
  await run("git", ["rev-parse", "--git-dir"], { cwd: repo });

  const root = resolve(input.root ?? join(repo, "runs", "worktrees"));
  await mkdir(root, { recursive: true });
  const path = join(root, input.threadId);

  // `--detach`: the session does not need a branch, and leaving branches behind
  // makes `git branch` unreadable after a few hundred sessions.
  await run("git", ["worktree", "add", "--detach", path], { cwd: repo });
  return { path, repo };
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await run("git", ["worktree", "remove", "--force", path], { cwd: resolve(repo) });
}

/** True when `repo` looks like a git working tree (used to decide whether isolation is possible). */
export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--git-dir"], { cwd: resolve(repo) });
    return true;
  } catch {
    return false;
  }
}
