import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { defineTool } from "@agentdesk/protocol";
import { z } from "zod";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);
const MAX_FILE_BYTES = 1_000_000;

/** `*` stays inside a path segment, `**` crosses them. Enough for tool use. */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char !== undefined && "\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char ?? "";
    }
  }
  return new RegExp(`${out}$`);
}

async function walk(
  root: string,
  dir: string,
  out: string[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out, limit);
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

export const globTool = defineTool({
  name: "fs.glob",
  description:
    "List workspace files matching a glob pattern (`*` within a segment, `**` across segments). Skips node_modules, .git and dotfiles.",
  risk: "safe",
  parameters: z.object({
    pattern: z.string().default("**/*").describe('Glob, e.g. "src/**/*.ts"'),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  async run(args, ctx) {
    const files: string[] = [];
    await walk(ctx.cwd, ctx.cwd, files, args.limit);
    const matcher = globToRegExp(args.pattern);
    const matched = files.filter((file) => matcher.test(file)).slice(0, args.limit);
    return {
      ok: true,
      output: matched.length === 0 ? "(no matches)" : matched.join("\n"),
      meta: { count: matched.length },
    };
  },
});

export const grepTool = defineTool({
  name: "fs.grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns `path:line: text` up to `limit` matches. Skips binaries and files above 1 MB.",
  risk: "safe",
  parameters: z.object({
    pattern: z.string().describe("Regular expression source"),
    include: z.string().default("**/*").describe("Only search files matching this glob"),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  async run(args, ctx) {
    let matcher: RegExp;
    let includeMatcher: RegExp;
    try {
      matcher = new RegExp(args.pattern);
      includeMatcher = globToRegExp(args.include);
    } catch (error) {
      return {
        ok: false,
        output: `invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const files: string[] = [];
    await walk(ctx.cwd, ctx.cwd, files, 5000);

    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= args.limit) break;
      if (!includeMatcher.test(file)) continue;

      const absolute = join(ctx.cwd, file);
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) continue;

      const raw = await readFile(absolute, "utf8");
      if (raw.includes("\u0000")) continue;

      const lines = raw.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!matcher.test(line)) continue;
        hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= args.limit) break;
      }
    }

    return {
      ok: true,
      output: hits.length === 0 ? "(no matches)" : hits.join("\n"),
      meta: { count: hits.length },
    };
  },
});
