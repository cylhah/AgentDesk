import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AgentEventSchema,
  newId,
  type AgentEvent,
  type Message,
  type ToolDef,
} from "@agentdesk/protocol";
import { formatTable, runCase, type EvalCase } from "@agentdesk/eval";
import {
  openAIProviderFromEnv,
  runTurn,
  ScriptedProvider,
  type ApprovalRequest,
  type RunTurnResult,
} from "@agentdesk/runtime";
import { JsonlSessionStore, SqliteSessionStore, deriveItems, type SessionStore } from "@agentdesk/store";
import { createAllTools, mediaSystemPrompt } from "@agentdesk/tools";

const FIXTURE_DIR = resolve(process.cwd(), "fixtures/media");
const RUN_DIR = resolve(process.cwd(), "runs/sessions");
// Chosen in main() from `--store`; both satisfy SessionStore.
let store: SessionStore = new JsonlSessionStore(RUN_DIR);
let storeKind: "jsonl" | "sqlite" = "jsonl";
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
    case "context.compacted":
      console.log(
        dim(
          `  ⇣ context ${event.tokensBefore} → ${event.tokensAfter} tokens` +
            ` (truncated ${event.truncatedToolResults}, elided ${event.elidedToolResults}, dropped ${event.droppedMessages})`,
        ),
      );
      break;
    case "error":
      console.log(`  ${red("! error")} ${event.message}`);
      break;
    case "usage":
      console.log(
        dim(
          `  usage: in=${event.inputTokens} out=${event.outputTokens}` +
            (event.source === undefined ? "" : ` (${event.source})`),
        ),
      );
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

/** Conversation state a host keeps across turns. */
interface Host {
  readonly threadId: string;
  messages: Message[];
  readonly system: string;
  readonly tracePath: string;
  /**
   * Tools are created once per session, not per turn: the media mock carries
   * state (`nowPlaying`, volume, window) that `next`/`pause` depend on. Creating
   * them per turn made "换一首" fail with "nothing is playing" one turn after a
   * successful play — the state had been silently reset.
   */
  readonly tools: readonly ToolDef[];
}

async function openHost(resumeId: string | undefined, providerId: string): Promise<Host> {
  const tools = createAllTools();

  if (resumeId !== undefined) {
    const loaded = await store.load(resumeId);
    return {
      threadId: resumeId,
      messages: [...loaded.messages],
      // Replay the policy the session was recorded with, not today's default.
      system: loaded.header.system ?? mediaSystemPrompt,
      tracePath: join(RUN_DIR, `${resumeId}.events.ndjson`),
      tools,
    };
  }

  const threadId = newId("thread");
  await store.create({
    threadId,
    cwd: process.cwd(),
    provider: providerId,
    system: mediaSystemPrompt,
  });
  return {
    threadId,
    messages: [],
    system: mediaSystemPrompt,
    tracePath: join(RUN_DIR, `${threadId}.events.ndjson`),
    tools,
  };
}

interface TurnOptions {
  readonly autoApprove: boolean;
  readonly maxSteps?: number;
}

/**
 * Runs one turn and durably records it *before* the next turn starts:
 * the event trace first (what happened), then the messages (what it meant).
 * A crash mid-write loses at most the last line, never the whole session.
 */
async function runOneTurn(host: Host, task: string, options: TurnOptions): Promise<RunTurnResult> {
  const provider = openAIProviderFromEnv();
  const turnId = newId("turn");
  const userMessage: Message = { role: "user", content: task };
  const before = host.messages.length;

  await store.appendMessage(host.threadId, turnId, userMessage);
  host.messages = [...host.messages, userMessage];

  const trace: AgentEvent[] = [];
  const result = await runTurn({
    threadId: host.threadId,
    turnId,
    messages: host.messages,
    provider,
    tools: host.tools,
    system: host.system,
    cwd: process.cwd(),
    approval: makeApproval(options.autoApprove),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    onEvent: (event) => {
      printEvent(event);
      trace.push(event);
    },
  });

  host.messages = [...result.messages];
  for (const message of result.messages.slice(before + 1)) {
    await store.appendMessage(host.threadId, turnId, message);
  }
  await store.appendTurn(host.threadId, {
    turnId,
    reason: result.reason,
    usage: result.usage,
  });

  if (trace.length > 0) {
    await mkdir(dirname(host.tracePath), { recursive: true });
    await appendFile(
      host.tracePath,
      `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
  }

  return result;
}

function reportSession(host: Host): void {
  console.log(dim(`\n  session ${host.threadId}`));
  console.log(dim(`  store       ${storeKind} · ${store.describe()}`));
  console.log(dim(`  events      ${host.tracePath}`));
  console.log(
    dim(`  continue    pnpm dev run "<task>" --resume ${host.threadId}`) +
      dim(`   (or: pnpm dev chat --resume ${host.threadId})`),
  );
}

async function runLive(task: string, options: TurnOptions, resumeId?: string): Promise<void> {
  const provider = openAIProviderFromEnv();
  console.log(dim(`provider ${provider.id}`));
  const host = await openHost(resumeId, provider.id);
  const result = await runOneTurn(host, task, options);

  if (result.reason === "awaiting_approval") {
    console.log(
      yellow(
        `\nstopped for approval: ${result.pendingApproval?.tool.name ?? "?"} — re-run with --yes to allow`,
      ),
    );
  }
  reportSession(host);
}

async function runChat(options: TurnOptions, resumeId?: string): Promise<void> {
  const provider = openAIProviderFromEnv();
  console.log(dim(`provider ${provider.id}`));
  const host = await openHost(resumeId, provider.id);
  if (host.messages.length > 0) {
    console.log(dim(`resumed ${host.messages.length} messages from ${host.threadId}`));
  }
  console.log(dim("/exit to stop · /session to show paths"));

  for (;;) {
    let line: string;
    try {
      line = (await ask(`\n${green("you")} `)).trim();
    } catch {
      break; // Ctrl+D / closed stdin
    }
    if (line === "/exit" || line === "/quit") break;
    if (line === "/session") {
      reportSession(host);
      continue;
    }
    if (line.length === 0) continue;

    await runOneTurn(host, line, options);
  }

  reportSession(host);
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

async function listSessions(): Promise<void> {
  const sessions = await store.list();
  if (sessions.length === 0) {
    console.log(dim(`no sessions yet — run: pnpm dev run "放周杰伦的晴天"`));
    return;
  }

  const rows = sessions.map((session) => [
    session.threadId,
    new Date(session.updatedAt).toISOString().slice(0, 16).replace("T", " "),
    String(session.turns),
    String(session.messages),
    session.firstUserText.length > 40
      ? `${session.firstUserText.slice(0, 40)}…`
      : session.firstUserText,
  ]);
  const header = ["thread", "updated", "turns", "msgs", "first user message"];
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log(dim(`\nstore: ${storeKind} · ${store.describe()}`));
  console.log(dim(`resume one with: pnpm dev chat --resume <thread>`));
}

/**
 * Prints the Thread/Turn/Item projection of a stored session. The messages are
 * the truth; this view is what a UI would page over — one assistant message
 * with two tool calls becomes three items.
 */
async function showItems(threadId: string | undefined): Promise<void> {
  if (threadId === undefined) {
    console.error(red("usage: items <thread>"));
    process.exitCode = 1;
    return;
  }

  const loaded = await store.load(threadId);
  const items = deriveItems(loaded.messages);

  console.log(dim(`thread ${threadId} · ${items.length} items · policy: ${loaded.header.system === undefined ? "(none)" : "recorded"}`));
  for (const item of items) {
    switch (item.kind) {
      case "user_message":
        console.log(`${green("user")}  ${item.text}`);
        break;
      case "assistant_message":
        console.log(`${cyan("asst")}  ${item.text}`);
        break;
      case "tool_call":
        console.log(`${yellow("call")}  ${item.call.name} ${dim(JSON.stringify(item.call.args))}`);
        break;
      case "tool_result":
        console.log(`${item.ok ? green("res") : red("res")}   ${item.callId} ${dim(item.output.slice(0, 120))}`);
        break;
    }
  }
}

async function replay(file: string | undefined): Promise<void> {
  if (file === undefined) {
    console.error(red("usage: replay <file.events.ndjson>"));
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = await readFile(resolve(process.cwd(), file), "utf8");
  } catch {
    console.error(red(`cannot read ${file}`));
    process.exitCode = 1;
    return;
  }

  let total = 0;
  let invalid = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    const event = AgentEventSchema.safeParse(parsed);
    if (!event.success) {
      invalid += 1;
      continue;
    }
    total += 1;
    printEvent(event.data);
  }

  console.log(
    dim(`\nreplayed ${total} events${invalid > 0 ? `, skipped ${invalid} invalid lines` : ""}`),
  );
  if (total === 0) process.exitCode = 1;
}

function usage(): void {
  console.log(
    [
      "agentdesk — local agent runtime",
      "",
      "Usage:",
      '  run "<task>" [--yes] [--resume <thread>]   one turn against the live model',
      "  chat [--yes] [--resume <thread>]           interactive; every turn is recorded",
      "  demo [caseId]                              replay a fixture through the real loop",
      "  eval [--live]                              score fixtures (scripted or live)",
      "  sessions                                   list recorded sessions",
      "  items <thread>                             print the Thread/Turn/Item view",
      "  replay <file.events.ndjson>                re-print a recorded event stream",
      "",
      "  --store jsonl|sqlite   where sessions live (default jsonl; sqlite is opt-in until the UI needs queries)",
      "",
      "Every live turn writes an event trace to runs/sessions/<thread>.events.ndjson.",
      "Sessions live in runs/sessions/ (jsonl) or runs/sessions/sessions.db (sqlite). Both are gitignored.",
      "",
      "Env: OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL (any OpenAI-compatible endpoint).",
    ].join("\n"),
  );
}

interface ParsedArgs {
  readonly flags: readonly string[];
  readonly positional: readonly string[];
  readonly resume?: string;
  readonly store?: string;
  readonly maxSteps?: number;
}

/**
 * Hand-rolled parsing because the CLI has three value-taking flags.
 * `--resume <id>` must consume its value, otherwise the id would be joined into
 * the task string (`run "放晴天" --resume thread_x` → task "放晴天 thread_x").
 */
function parseArgs(args: readonly string[]): ParsedArgs {
  const flags: string[] = [];
  const positional: string[] = [];
  let resume: string | undefined;
  let storeKindArg: string | undefined;
  let maxSteps: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--resume") {
      resume = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      resume = arg.slice("--resume=".length);
      continue;
    }
    if (arg === "--store") {
      storeKindArg = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--store=")) {
      storeKindArg = arg.slice("--store=".length);
      continue;
    }
    if (arg === "--max-steps") {
      maxSteps = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-steps=")) {
      maxSteps = Number(arg.slice("--max-steps=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      flags.push(arg);
      continue;
    }
    positional.push(arg);
  }

  return {
    flags,
    positional,
    ...(resume !== undefined ? { resume } : {}),
    ...(storeKindArg !== undefined ? { store: storeKindArg } : {}),
    ...(maxSteps !== undefined && Number.isFinite(maxSteps) ? { maxSteps } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const parsed = parseArgs(argv.slice(1));
  const { flags, positional, resume: resumeId } = parsed;
  const options: TurnOptions = {
    autoApprove: flags.includes("--yes"),
    ...(parsed.maxSteps !== undefined ? { maxSteps: parsed.maxSteps } : {}),
  };

  if (parsed.store !== undefined && parsed.store !== "jsonl" && parsed.store !== "sqlite") {
    console.error(red(`unknown store: ${parsed.store} (expected jsonl or sqlite)`));
    process.exitCode = 1;
    return;
  }
  storeKind = parsed.store === "sqlite" ? "sqlite" : "jsonl";
  store = storeKind === "sqlite" ? new SqliteSessionStore(join(RUN_DIR, "sessions.db")) : new JsonlSessionStore(RUN_DIR);

  if (command === "run") {
    if (flags.includes("--mock")) {
      await runDemo(positional[0]);
      return;
    }
    const task = positional.join(" ").trim();
    if (task.length === 0) {
      console.error(red('usage: run "<task>" — the task is the prompt'));
      process.exitCode = 1;
      return;
    }
    await runLive(task, options, resumeId);
    return;
  }

  if (command === "chat") {
    await runChat(options, resumeId);
    return;
  }

  if (command === "eval") {
    await runEval(flags.includes("--live"));
    return;
  }

  if (command === "sessions") {
    await listSessions();
    return;
  }

  if (command === "items") {
    await showItems(positional[0]);
    return;
  }

  if (command === "replay") {
    await replay(positional[0]);
    return;
  }

  if (command === "demo") {
    await runDemo(positional[0]);
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
  store.close();
}
