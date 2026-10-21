import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { defineTool } from "@agentdesk/protocol";
import { z } from "zod";

/**
 * Every path a tool touches must stay inside the workspace.
 * This is the process-level stand-in for the worktree isolation landing in Week 4 —
 * a real sandbox enforces this at the OS level, not with string checks.
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
  name: "fs_read",
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

export const writeTool = defineTool({
  name: "fs_write",
  description:
    "Create or overwrite a UTF-8 text file inside the workspace. Parent directories are created automatically.",
  risk: "safe",
  parameters: z.object({
    path: z.string().describe("Workspace-relative file path"),
    content: z.string().describe("Full file content"),
  }),
  async run(args, ctx) {
    const absolute = resolveInside(ctx.cwd, args.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, args.content, "utf8");
    return {
      ok: true,
      output: `wrote ${args.content.length} chars to ${args.path}`,
      meta: { bytes: Buffer.byteLength(args.content, "utf8") },
    };
  },
});

export const patchTool = defineTool({
  name: "fs_patch",
  description:
    "Replace an exact text fragment in a file. Fails if the fragment is missing or appears more than once (pass replaceAll to allow that). Prefer this over rewriting whole files.",
  risk: "safe",
  parameters: z.object({
    path: z.string().describe("Workspace-relative file path"),
    oldText: z.string().min(1).describe("Exact text to find, including indentation"),
    newText: z.string().describe("Replacement text"),
    replaceAll: z.boolean().default(false).describe("Replace every occurrence"),
  }),
  async run(args, ctx) {
    const absolute = resolveInside(ctx.cwd, args.path);
    const raw = await readFile(absolute, "utf8");
    const occurrences = raw.split(args.oldText).length - 1;

    if (occurrences === 0) {
      return {
        ok: false,
        output: `oldText not found in ${args.path}; read the file again before patching`,
      };
    }
    if (occurrences > 1 && !args.replaceAll) {
      return {
        ok: false,
        output: `oldText appears ${occurrences} times in ${args.path}; add surrounding context or pass replaceAll`,
      };
    }

    const next = args.replaceAll
      ? raw.split(args.oldText).join(args.newText)
      : raw.replace(args.oldText, args.newText);
    await writeFile(absolute, next, "utf8");

    return {
      ok: true,
      output: `patched ${args.path} (${occurrences} occurrence${occurrences > 1 ? "s" : ""})`,
      meta: { occurrences },
    };
  },
});
