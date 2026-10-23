import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAllTools,
  globTool,
  grepTool,
  patchTool,
  readTool,
  shellTool,
  writeTool,
} from "@agentdesk/tools";
import { TOOL_NAME_PATTERN } from "@agentdesk/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdesk-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = () => ({ threadId: "thread_1", turnId: "turn_1", cwd: dir });

describe("fs tools", () => {
  it("writes and reads back a file, creating parent directories", async () => {
    const written = await writeTool.run({ path: "a/b.txt", content: "hello\nworld" }, ctx());
    expect(written.ok).toBe(true);

    const read = await readTool.run({ path: "a/b.txt", offset: 1, limit: 10 }, ctx());
    expect(read.ok).toBe(true);
    expect(read.output).toContain("1\thello");
    expect(read.output).toContain("2\tworld");
  });

  it("refuses to escape the workspace", async () => {
    await expect(
      writeTool.run({ path: "../../evil.txt", content: "x" }, ctx()),
    ).rejects.toThrow(/escapes workspace/);
  });

  it("patches an exact fragment", async () => {
    await writeTool.run({ path: "c.ts", content: "const a = 1;\nconst b = 2;" }, ctx());
    const result = await patchTool.run(
      { path: "c.ts", oldText: "const a = 1;", newText: "const a = 10;", replaceAll: false },
      ctx(),
    );
    expect(result.ok).toBe(true);

    const read = await readTool.run({ path: "c.ts", offset: 1, limit: 10 }, ctx());
    expect(read.output).toContain("const a = 10;");
  });

  it("fails loudly when the patch target is missing or ambiguous", async () => {
    await writeTool.run({ path: "d.ts", content: "x x" }, ctx());

    const missing = await patchTool.run(
      { path: "d.ts", oldText: "zzz", newText: "y", replaceAll: false },
      ctx(),
    );
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("not found");

    const ambiguous = await patchTool.run(
      { path: "d.ts", oldText: "x", newText: "y", replaceAll: false },
      ctx(),
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.output).toContain("2 times");
  });
});

describe("search tools", () => {
  it("globs files and skips ignored directories", async () => {
    await writeTool.run({ path: "src/a.ts", content: "export const a = 1;" }, ctx());
    await writeTool.run({ path: "src/nested/b.ts", content: "export const b = 2;" }, ctx());
    await writeTool.run({ path: "node_modules/pkg/c.ts", content: "nope" }, ctx());

    const result = await globTool.run({ pattern: "**/*.ts", limit: 100 }, ctx());
    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("src/nested/b.ts");
    expect(result.output).not.toContain("node_modules");
  });

  it("greps with path:line: text output", async () => {
    await writeTool.run({ path: "src/x.ts", content: "const alpha = 1;\nconst beta = 2;" }, ctx());

    const result = await grepTool.run(
      { pattern: "alpha", include: "**/*.ts", limit: 10 },
      ctx(),
    );
    expect(result.output).toContain("src/x.ts:1:");
    expect(result.output).toContain("alpha");
  });
});

describe("shell tool", () => {
  it("runs a command and reports the exit code", async () => {
    const result = await shellTool.run({ command: "echo agentdesk", timeoutMs: 10_000 }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("agentdesk");
    expect(result.output).toContain("exit=0");
  });
});

describe("tool catalog", () => {
  it("only exposes wire-legal names to the model", () => {
    // Regression guard: `fs.read` used to pass every offline test and then get
    // rejected by the real endpoint with HTTP 400 before the model ran at all.
    for (const tool of createAllTools()) {
      expect(TOOL_NAME_PATTERN.test(tool.name), `illegal tool name: ${tool.name}`).toBe(true);
    }
  });

  it("keeps player state when the same tool set is reused across turns", async () => {
    // The CLI used to call createAllTools() once per turn, which silently reset
    // `nowPlaying` — so "换一首" one turn after a successful play answered
    // "nothing is playing". The tool set must live as long as the session.
    const tools = createAllTools();
    const play = tools.find((tool) => tool.name === "play");
    const next = tools.find((tool) => tool.name === "next");
    expect(play).toBeDefined();
    expect(next).toBeDefined();

    const ctx = { threadId: "thread_1", turnId: "turn_1", cwd: dir };
    const played = await play?.run({ trackId: "t-001" }, ctx);
    expect(played?.output).toContain("晴天");

    const skipped = await next?.run({}, ctx);
    expect(skipped?.ok).toBe(true);
    expect(skipped?.output).toContain("七里香");
  });
});
