import type { ToolDef } from "@agentdesk/protocol";
import { codingSystemPrompt } from "./coding.policy";
import { mediaSystemPrompt } from "./media.policy";
import { createMediaTools, createWorkspaceTools } from "./sets";

/**
 * A scenario is a tool set plus the policy that explains it.
 *
 * This is where "one runtime, two scenarios" stops being a diagram: the runtime
 * never learns what a scenario is — the host picks one and passes both pieces in.
 *
 * Tool subsetting is also the biggest single cost lever: shipping all 13 tools
 * costs ~1.7k input tokens on *every* request, and a media turn only needs 7.
 */
export interface Scenario {
  readonly id: string;
  readonly tools: readonly ToolDef[];
  readonly systemPrompt: string;
}

export const mediaScenario: Scenario = {
  id: "media",
  tools: createMediaTools(),
  systemPrompt: mediaSystemPrompt,
};

export const codingScenario: Scenario = {
  id: "coding",
  tools: createWorkspaceTools(),
  systemPrompt: codingSystemPrompt,
};

export const scenarios: Readonly<Record<string, Scenario>> = {
  media: mediaScenario,
  coding: codingScenario,
};

export function resolveScenario(id: string | undefined): Scenario {
  if (id === undefined) return mediaScenario;
  const scenario = scenarios[id];
  if (scenario === undefined) {
    const known = Object.keys(scenarios).join(", ");
    throw new Error(`unknown scenario: ${id} (expected one of: ${known})`);
  }
  return scenario;
}
