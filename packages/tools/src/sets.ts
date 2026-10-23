import type { ToolDef } from "@agentdesk/protocol";
import { patchTool, readTool, writeTool } from "./fs";
import { createMockMediaTools } from "./media.mock";
import { globTool, grepTool } from "./search";
import { shellTool } from "./shell";

/** File + shell tools: the "coding" domain. Scenario-agnostic plumbing. */
export function createWorkspaceTools(): ToolDef[] {
  return [readTool, writeTool, patchTool, globTool, grepTool, shellTool];
}

/** Media domain only — 7 tools instead of 13, which is ~30% fewer prompt tokens. */
export function createMediaTools(): ToolDef[] {
  return createMockMediaTools();
}

/** Everything, for tests and for "let the model decide" experiments. */
export function createAllTools(): ToolDef[] {
  return [...createWorkspaceTools(), ...createMediaTools()];
}
