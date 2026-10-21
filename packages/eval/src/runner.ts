import type { Message, ToolDef } from "@agentdesk/protocol";
import {
  runTurn,
  ScriptedProvider,
  type ModelProvider,
} from "@agentdesk/runtime";
import type { CaseResult, EvalCase, ExpectedCall } from "./types";

function argsMatch(actual: unknown, expected: Readonly<Record<string, unknown>> | undefined): boolean {
  if (expected === undefined) return true;
  if (typeof actual !== "object" || actual === null) return false;
  return Object.entries(expected).every(
    ([key, value]) => (actual as Record<string, unknown>)[key] === value,
  );
}

/**
 * Order-preserving subsequence match: extra calls in between are allowed,
 * missing or out-of-order expected calls are not.
 */
function matchSequence(
  calls: readonly { name: string; args: unknown }[],
  expected: readonly ExpectedCall[],
): string[] {
  const failures: string[] = [];
  let cursor = 0;
  for (const want of expected) {
    let found = false;
    while (cursor < calls.length) {
      const call = calls[cursor];
      cursor += 1;
      if (call !== undefined && call.name === want.name && argsMatch(call.args, want.args)) {
        found = true;
        break;
      }
    }
    if (!found) failures.push(`missing call: ${want.name} ${JSON.stringify(want.args ?? {})}`);
  }
  return failures;
}

export interface RunCaseOptions {
  /** Live model instead of the fixture's script. */
  readonly provider?: ModelProvider;
  /** Scenario policy handed to the model. Without it a live model behaves like a chat app. */
  readonly system?: string;
}

export async function runCase(
  testCase: EvalCase,
  tools: readonly ToolDef[],
  options: RunCaseOptions = {},
): Promise<CaseResult> {
  const provider =
    options.provider ?? new ScriptedProvider(testCase.script, `scripted:${testCase.id}`);
  const calls: { name: string; args: unknown }[] = [];

  let messages: readonly Message[] = [];
  let reason = "completed";
  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;

  for (const input of testCase.inputs) {
    messages = [...messages, { role: "user", content: input }];
    const result = await runTurn({
      threadId: `thread:${testCase.id}`,
      messages,
      provider,
      tools,
      ...(options.system !== undefined ? { system: options.system } : {}),
      onEvent: (event) => {
        if (event.type === "tool.call") {
          calls.push({ name: event.name, args: event.args });
        }
      },
    });
    messages = result.messages;
    reason = result.reason;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    steps += result.usage.steps;
  }

  const failures: string[] = [];

  const wantsApproval = testCase.expect.expectApproval === true;
  if (wantsApproval && reason !== "awaiting_approval") {
    failures.push(`expected approval gate, turn ended with "${reason}"`);
  }
  if (!wantsApproval && reason === "awaiting_approval") {
    failures.push("unexpected approval gate");
  }

  if (testCase.expect.mustCall !== undefined) {
    failures.push(...matchSequence(calls, testCase.expect.mustCall));
  }

  for (const forbidden of testCase.expect.mustNotCall ?? []) {
    if (calls.some((call) => call.name === forbidden)) {
      failures.push(`forbidden call executed: ${forbidden}`);
    }
  }

  return {
    id: testCase.id,
    title: testCase.title,
    ok: failures.length === 0,
    reason,
    calls,
    steps,
    inputTokens,
    outputTokens,
    failures,
  };
}

export function formatTable(results: readonly CaseResult[]): string {
  const header = ["case", "result", "reason", "steps", "tokens", "calls"];
  const rows = results.map((result) => [
    result.id,
    result.ok ? "PASS" : "FAIL",
    result.reason,
    String(result.steps),
    String(result.inputTokens + result.outputTokens),
    result.calls.map((call) => call.name).join(" > ") || "-",
  ]);

  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  const passing = results.filter((result) => result.ok).length;
  const detail = results
    .filter((result) => !result.ok)
    .flatMap((result) => result.failures.map((failure) => `  ${result.id}: ${failure}`));

  return [
    line(header),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => line(row)),
    "",
    `summary: ${passing}/${results.length} passed`,
    ...detail,
  ].join("\n");
}
