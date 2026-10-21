import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { defineTool } from "@agentdesk/protocol";
import { z } from "zod";

/**
 * Every path a tool touches must stay inside the workspace.
 * This is the process-level stand-in for the worktree isolation landing in Week 4.
 */
export function resolveInside(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const root = resolve(cwd);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error(`path escapes workspace: ${path}`);
  }
  return absolute;
}

export const readTool = defineTool({
  name: "fs.read",
  description:
    "Read a UTF-8 text file inside the workspace. Returns numbered lines, at most `limit` lines starting from `offset` (1-based).",
  risk: "safe",
  parameters: z.object({
    path: z.string().describe("Workspace-relative file path"),
    offset: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(2000).default(400),
  }),
  async run(args, ctx) {
    const absolute = resolveInside(ctx.cwd, args.path);
    const raw = await readFile(absolute, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = args.offset - 1;
    const slice = lines.slice(start, start + args.limit);
    const numbered = slice.map((line, index) => `${start + index + 1}\t${line}`);
    const truncated = start + slice.length < lines.length;
    return {
      ok: true,
      output: numbered.join("\n") + (truncated ? "\n… (truncated)" : ""),
      meta: { totalLines: lines.length },
    };
  },
});

/**
 * TODO(Week 1, D2–D3) — implement these next, in this order:
 *   fs.write  { path, content }             risk: safe, but must stay inside cwd
 *   fs.patch  { path, oldText, newText }    risk: safe, must fail loudly if oldText is absent or ambiguous
 *   shell.run { command, timeoutMs }        risk: confirm, truncate output to N chars
 *   fs.glob   { pattern }                   risk: safe
 *   fs.grep   { pattern, include? }         risk: safe
 *
 * Each one: validate with zod, cap output size, never throw on "expected" failures —
 * return { ok: false, output } so the loop can feed the error back to the model.
 */
export const pendingTools = [
  "fs.write",
  "fs.patch",
  "shell.run",
  "fs.glob",
  "fs.grep",
] as const;
