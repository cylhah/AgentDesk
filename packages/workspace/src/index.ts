import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
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

export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly bare: boolean;
}

/** Parses `git worktree list --porcelain`; the first entry is the main checkout. */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], {
    cwd: resolve(repo),
  });

  const entries: WorktreeEntry[] = [];
  let current: { path?: string; head?: string; bare: boolean } | undefined;

  const flush = (): void => {
    if (current?.path !== undefined) {
      entries.push({
        path: current.path,
        bare: current.bare,
        ...(current.head !== undefined ? { head: current.head } : {}),
      });
    }
    current = undefined;
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), bare: false };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    if (line === "bare") current.bare = true;
  }
  flush();

  return entries;
}

export interface PruneWorktreeInput {
  readonly repo: string;
  readonly root?: string;
  /** Remove worktrees whose directory has not been touched for this long. */
  readonly olderThanMs: number;
}

/**
 * Deletes stale per-session worktrees. Only paths under `root` (default
 * `runs/worktrees`) are ever candidates — a hand-made worktree elsewhere is the
 * user's business, not the agent's.
 */
export async function pruneWorktrees(input: PruneWorktreeInput): Promise<string[]> {
  const repo = resolve(input.repo);
  const root = resolve(input.root ?? join(repo, "runs", "worktrees"));
  const entries = await listWorktrees(repo);
  const removed: string[] = [];
  const cutoff = Date.now() - Math.max(0, input.olderThanMs);

  for (const entry of entries) {
    const path = resolve(entry.path);
    if (path === repo || !path.startsWith(root)) continue;

    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue; // already gone
    }
    if (mtimeMs > cutoff) continue;

    await removeWorktree(repo, path);
    removed.push(path);
  }

  await run("git", ["worktree", "prune"], { cwd: repo });
  return removed;
}
