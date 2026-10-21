import { z } from "zod";
import { zodToJsonSchema } from "./json-schema";

/**
 * Risk tiers drive the approval gate.
 * - safe:      executed immediately
 * - confirm:   requires an approval callback, otherwise the turn halts
 * - forbidden: never executed (hard kill switch, e.g. destructive ops in prod)
 */
export const RiskLevelSchema = z.enum(["safe", "confirm", "forbidden"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export interface ToolContext {
  readonly threadId: string;
  readonly turnId: string;
  /** Workspace root. Every path a tool touches must resolve inside it. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Non-generic on purpose: arrays of `ToolDef` stay assignable without
 * variance gymnastics. `defineTool` restores type safety at the definition site.
 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly parameters: z.ZodTypeAny;
  readonly run: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

/** Wire format handed to the model (JSON Schema). */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/**
 * OpenAI-compatible function names: `^[a-zA-Z0-9_-]{1,64}$`.
 * A dot is rejected by the API (`fs.read` → HTTP 400), so names use underscores.
 * Checked at definition time: a bad name fails at startup, not on the first request.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function defineTool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  risk: RiskLevel;
  parameters: S;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}): ToolDef {
  if (!TOOL_NAME_PATTERN.test(def.name)) {
    throw new Error(
      `invalid tool name "${def.name}": must match ${String(TOOL_NAME_PATTERN)} (dots are rejected by OpenAI function calling)`,
    );
  }
  return {
    name: def.name,
    description: def.description,
    risk: def.risk,
    parameters: def.parameters,
    run: (args, ctx) => def.run(args as z.infer<S>, ctx),
  };
}

export function toToolSpec(tool: ToolDef): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parameters),
  };
}
