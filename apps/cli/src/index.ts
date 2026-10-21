import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { newId, type AgentEvent, type Message } from "@agentdesk/protocol";
import { formatTable, runCase, type EvalCase } from "@agentdesk/eval";
import {
  openAIProviderFromEnv,
  runTurn,
  ScriptedProvider,
  type ApprovalRequest,
} from "@agentdesk/runtime";
import { createAllTools, mediaSystemPrompt } from "@agentdesk/tools";

const FIXTURE_DIR = resolve(process.cwd(), "fixtures/media");
const useColor = process.stdout.isTTY === true;

const paint = (code: string, text: string): string =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

const dim = (text: string): string => paint("2", text);
const cyan = (text: string): string => paint("36", text);
const green = (text: string): string => paint("32", text);
const yellow = (text: string): string => paint("33", text);
const red = (text: string): string => paint("31", text);

let rl: ReturnType<typeof createInterface> | undefined;

async function ask(question: string): Promise<string> {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return await rl.question(question);
}

function closePrompt(): void {
  rl?.close();
  rl = undefined;
}

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
      if (event.text.length > 0) console.log(`  ${green("assistant")} ${event.text}`);
      break;
    case "tool.call":
      console.log(
        `  ${yellow("→ tool")} ${event.name} ${dim(JSON.stringify(event.args))}`,
      );
      break;
    case "tool.result": {
      const body =
        event.output.length > 200 ? `${event.output.slice(0, 200)}…` : event.output;
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

function makeApproval(autoApprove: boolean) {
  return async ({ tool, args }: ApprovalRequest): Promise<boolean> => {
    if (autoApprove) {
      console.log(dim(`  (auto-approved) ${tool.name}`));
      return true;
    }
    if (process.stdin.isTTY !== true) {
      console.log(red(`  no TTY to ask — denying ${tool.name} (pass --yes to allow)`));
      return false;
    }
    const answer = await ask(
      `\n  ${yellow("approve")} ${tool.name} ${dim(JSON.stringify(args))} ? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  };
}

async function runDemo(caseId: string | undefined): Promise<void> {
  const cases = await loadCases();
  const target = caseId === undefined ? cases[0] : cases.find((item) => item.id === caseId);
  if (target === undefined) {
    console.error(red(`no such case: ${caseId ?? "(none)"}`));
    process.exitCode = 1;
    return;
  }

  const tools = createAllTools();
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
      system: mediaSystemPrompt,
      cwd: process.cwd(),
      onEvent: printEvent,
    });
    messages = result.messages;
  }
}

interface RunOptions {
  readonly autoApprove: boolean;
  readonly maxSteps?: number;
}

async function runLive(task: string, options: RunOptions): Promise<void> {
  const provider = openAIProviderFromEnv();
  console.log(dim(`provider ${provider.id}`));

  const result = await runTurn({
    threadId: newId("thread"),
    messages: [{ role: "user", content: task }],
    provider,
    tools: createAllTools(),
    system: mediaSystemPrompt,
    cwd: process.cwd(),
    approval: makeApproval(options.autoApprove),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    onEvent: printEvent,
  });

  if (result.reason === "awaiting_approval") {
    console.log(
      yellow(
        `\nstopped for approval: ${result.pendingApproval?.tool.name ?? "?"} — re-run with --yes to allow`,
      ),
    );
  }
}

async function runEval(live: boolean): Promise<void> {
  const cases = await loadCases();
  const tools = createAllTools();
  const provider = live ? openAIProviderFromEnv() : undefined;

  if (live) {
    console.log(yellow(`live eval against ${provider?.id} — this costs tokens`));
  }

  const results = [];
  for (const item of cases) {
    results.push(
      await runCase(item, tools, {
        system: mediaSystemPrompt,
        ...(provider === undefined ? {} : { provider }),
      }),
    );
  }

  console.log(formatTable(results));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

function usage(): void {
  console.log(
    [
      "agentdesk — local agent runtime",
      "",
      "Usage:",
      "  pnpm dev run --mock [caseId]        replay a fixture through the real loop",
      '  pnpm dev run "<task>" [--yes]       run against the live model',
      "  pnpm dev eval [--live]              score fixtures (scripted or live)",
      "",
      "Env: OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL (any OpenAI-compatible endpoint).",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const rest = argv.slice(1);
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const positional = rest.filter((arg) => !arg.startsWith("--"));

  if (command === "run") {
    if (flags.includes("--mock")) {
      await runDemo(positional[0]);
      return;
    }
    const task = positional.join(" ").trim();
    if (task.length === 0) {
      console.error(red("usage: run \"<task>\" — the task is the prompt"));
      process.exitCode = 1;
      return;
    }
    const maxStepsFlag = rest.find((arg) => arg.startsWith("--max-steps="));
    await runLive(task, {
      autoApprove: flags.includes("--yes"),
      ...(maxStepsFlag !== undefined
        ? { maxSteps: Number(maxStepsFlag.split("=")[1]) }
        : {}),
    });
    return;
  }

  if (command === "eval") {
    await runEval(flags.includes("--live"));
    return;
  }

  usage();
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(red(`\nerror: ${message}`));
  process.exitCode = 1;
} finally {
  closePrompt();
}
