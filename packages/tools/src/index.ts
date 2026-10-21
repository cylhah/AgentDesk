import type { ToolDef } from "@agentdesk/protocol";
import { patchTool, readTool, writeTool } from "./fs";
import { createMockMediaTools } from "./media.mock";
import { globTool, grepTool } from "./search";
import { shellTool } from "./shell";

export * from "./registry";
export * from "./fs";
export * from "./search";
export * from "./shell";
export * from "./media.mock";
export * from "./media.policy";

/** File + shell tools: the "coding" domain. Scenario-agnostic plumbing. */
export function createWorkspaceTools(): ToolDef[] {
  return [readTool, writeTool, patchTool, globTool, grepTool, shellTool];
}

/** Everything, for the media scenario. */
export function createAllTools(): ToolDef[] {
  return [...createWorkspaceTools(), ...createMockMediaTools()];
}
