import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentEvent, Message } from "@agentdesk/protocol";
import { formatTable, runCase, type EvalCase } from "@agentdesk/eval";
import { runTurn, ScriptedProvider } from "@agentdesk/runtime";
import { createMockMediaTools } from "@agentdesk/tools";

const FIXTURE_DIR = resolve(process.cwd(), "fixtures/media");
const useColor = process.stdout.isTTY === true;

const paint = (code: string, text: string): string =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

const dim = (text: string): string => paint("2", text);
const cyan = (text: string): string => paint("36", text);
const green = (text: string): string => paint("32", text);
const yellow = (text: string): string => paint("33", text);
const red = (text: string): string => paint("31", text);

async function loadCases(): Promise<EvalCase[]> {
  const files = (await readdir(FIXTURE_DIR))
    .filter((file) => file.endsWith(".json"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const raw = await readFile(join(FIXTURE_DIR, file), "utf8");
      return JSON.parse(raw) as EvalCase;
    }),
  );
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "turn.start":
      console.log(cyan(`\n▶ turn ${event.turnId}`));
      break;
    case "message.complete":
      console.log(`  ${green("assistant")} ${event.text}`);
      break;
    case "tool.call":
      console.log(`  ${yellow("→ tool")} ${event.name} ${dim(JSON.stringify(event.args))}`);
      break;
    case "tool.result": {
      const body = event.output.length > 160 ? `${event.output.slice(0, 160)}…` : event.output;
      console.log(`  ${event.ok ? green("✓") : red("✗")} ${dim(body)}`);
      break;
    }
    case "tool.approval_required":
      console.log(
        `  ${red("⏸ approval required")} ${event.name} ${dim(JSON.stringify(event.args))}`,
      );
      break;
    case "error":
      console.log(`  ${red("! error")} ${event.message}`);
      break;
    case "usage":
      console.log(dim(`  usage: in=${event.inputTokens} out=${event.outputTokens}`));
      break;
    case "turn.end":
      console.log(dim(`  ⏹ ${event.reason}`));
      break;
    case "message.delta":
      break;
  }
}

async function runDemo(caseId: string | undefined): Promise<void> {
  const cases = await loadCases();
  const target = caseId === undefined ? cases[0] : cases.find((item) => item.id === caseId);
  if (target === undefined) {
    console.error(red(`no such case: ${caseId ?? "(none)"}`));
    process.exitCode = 1;
    return;
  }

  const tools = createMockMediaTools();
  const provider = new ScriptedProvider(target.script, `scripted:${target.id}`);
  let messages: readonly Message[] = [];

  console.log(dim(`case ${target.id} — ${target.title}`));
  for (const input of target.inputs) {
    console.log(`\n${green("user")} ${input}`);
    messages = [...messages, { role: "user", content: input }];
    const result = await runTurn({
      threadId: `thread:${target.id}`,
      messages,
      provider,
      tools,
      onEvent: printEvent,
    });
    messages = result.messages;
  }
}

async function runEval(): Promise<void> {
  const cases = await loadCases();
  const tools = createMockMediaTools();
  const results = [];
  for (const item of cases) {
    results.push(await runCase(item, tools));
  }
  console.log(formatTable(results));
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

function usage(): void {
  console.log(
    [
      "agentdesk — local agent runtime",
      "",
      "Usage:",
      "  pnpm dev run --mock [caseId]   replay a fixture through the real loop",
      "  pnpm dev eval                  run every fixture, print a score table",
      "",
      'TODO(Week 1): run "<task>" against a live model provider.',
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";

  if (command === "run") {
    const rest = argv.slice(1);
    const mock = rest.includes("--mock");
    const caseId = rest.find((arg) => !arg.startsWith("--"));
    if (!mock) {
      console.error(yellow("live provider not wired yet — pass --mock, see TODO(Week 1)"));
      process.exitCode = 1;
      return;
    }
    await runDemo(caseId);
    return;
  }

  if (command === "eval") {
    await runEval();
    return;
  }

  usage();
}

await main();
