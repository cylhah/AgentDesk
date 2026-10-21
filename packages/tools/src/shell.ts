import { spawn } from "node:child_process";
import { defineTool } from "@agentdesk/protocol";
import { z } from "zod";

const MAX_OUTPUT_CHARS = 8_000;

/**
 * Runs with the platform shell. Marked `confirm` because a shell command can do
 * anything the user can — the sandbox in Week 4 narrows *what* it can reach,
 * but the approval gate is what stops it before it starts.
 */
export const shellTool = defineTool({
  name: "shell.run",
  description:
    "Run a shell command in the workspace and return combined stdout/stderr. Output is truncated. Requires user approval.",
  risk: "confirm",
  parameters: z.object({
    command: z.string().describe("Command line, executed with the platform shell"),
    timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  }),
  async run(args, ctx) {
    return await new Promise((resolve) => {
      let settled = false;
      let output = "";
      let truncated = false;

      const append = (chunk: string): void => {
        if (output.length >= MAX_OUTPUT_CHARS) {
          truncated = true;
          return;
        }
        output += chunk;
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS);
          truncated = true;
        }
      };

      const finish = (code: number | null, note?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const tail = [
          truncated ? "… (output truncated)" : "",
          note ?? "",
          `exit=${code === null ? "killed" : code}`,
        ]
          .filter((part) => part.length > 0)
          .join("\n");
        resolve({ ok: code === 0, output: `${output.trimEnd()}\n${tail}` });
      };

      const child = spawn(args.command, {
        shell: true,
        cwd: ctx.cwd,
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        child.kill();
        finish(null, `(timed out after ${args.timeoutMs}ms)`);
      }, args.timeoutMs);

      child.stdout?.on("data", (data: Buffer) => append(data.toString()));
      child.stderr?.on("data", (data: Buffer) => append(data.toString()));
      child.on("error", (error: Error) => {
        append(`\n${error.message}`);
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  },
});
