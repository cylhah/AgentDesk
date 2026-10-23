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
  makeProviderSummarizer,
  openAIProviderFromEnv,
  runTurn,
  ScriptedProvider,
  type ApprovalRequest,
  type RunTurnResult,
} from "@agentdesk/runtime";
import { AuditLog, JsonlSessionStore, SqliteSessionStore, deriveItems, type SessionStore } from "@agentdesk/store";
import { mediaScenario, resolveScenario, type Scenario } from "@agentdesk/tools";
import { createWorktree } from "@agentdesk/workspace";

const FIXTURE_DIR = resolve(process.cwd(), "fixtures/media");
const RUN_DIR = resolve(process.cwd(), "runs/sessions");
const auditLog = new AuditLog(resolve(process.cwd(), "runs/audit.ndjson"));
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
    case "tool.approval_resolved":
      console.log(
        `  ${event.decision === "approve" ? green("✓ approved") : red("✗ denied")} ${event.name}`,
      );
      break;
    case "context.summarized":
      console.log(
        dim(
          `  ⇣ summarized ${event.summarizedMessages} old messages → ${event.tokensBefore} → ${event.tokensAfter} tokens` +
            ` (kept ${event.keptMessages})`,
        ),
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
  /** Persisted semantic summary of the head of the conversation, if any. */
  summary?: { readonly text: string; readonly frontier: number };
  /** Where this session is allowed to work: the repo, or an isolated worktree. */
  readonly cwd: string;
}

async function openHost(
  resumeId: string | undefined,
  providerId: string,
  scenario: Scenario,
  isolate: boolean,
): Promise<Host> {
  const tools = scenario.tools;

  if (resumeId !== undefined) {
    const loaded = await store.load(resumeId);
    return {
      threadId: resumeId,
      messages: [...loaded.messages],
      // Replay the policy the session was recorded with, not today's default.
      system: loaded.header.system ?? scenario.systemPrompt,
      tracePath: join(RUN_DIR, `${resumeId}.events.ndjson`),
      tools,
      // A resumed session keeps working where it was created (worktree included).
      cwd: loaded.header.cwd,
      ...(loaded.summary !== undefined ? { summary: loaded.summary } : {}),
    };
  }

  const threadId = newId("thread");
  const cwd = isolate
    ? (await createWorktree({ repo: process.cwd(), threadId })).path
    : process.cwd();
  await store.create({
    threadId,
    cwd,
    provider: providerId,
    system: scenario.systemPrompt,
  });
  return {
    threadId,
    messages: [],
    system: scenario.systemPrompt,
    tracePath: join(RUN_DIR, `${threadId}.events.ndjson`),
    tools,
    cwd,
  };
}

interface TurnOptions {
  readonly autoApprove: boolean;
  readonly maxSteps?: number;
  readonly summarize?: boolean;
  readonly summarizeAt?: number;
  readonly worktree?: boolean;
}

/**
 * Runs one turn and durably records it *before* the next turn starts:
 * the event trace first (what happened), then the messages (what it meant).
 * A crash mid-write loses at most the last line, never the whole session.
 *
 * A turn that stops at `awaiting_approval` is continued in place (same turnId,
 * same messages) once the host decides — re-running it from scratch would replay
 * side effects and hide the pending call from the model.
 */
async function runOneTurn(host: Host, task: string, options: TurnOptions): Promise<RunTurnResult> {
  const provider = openAIProviderFromEnv();
  const turnId = newId("turn");
  const userMessage: Message = { role: "user", content: task };
  const before = host.messages.length;

  await store.appendMessage(host.threadId, turnId, userMessage);
  host.messages = [...host.messages, userMessage];

  const trace: AgentEvent[] = [];
  const onEvent = (event: AgentEvent): void => {
    printEvent(event);
    trace.push(event);
  };

  const call = async (
    messages: readonly Message[],
    resume?: { callId: string; decision: "approve" | "deny" },
  ): Promise<RunTurnResult> =>
    await runTurn({
      threadId: host.threadId,
      turnId,
      messages,
      provider,
      tools: host.tools,
      system: host.system,
      cwd: host.cwd,
      // No approval callback on purpose: the turn parks at `awaiting_approval`
      // and `decidePending` resumes it with the exact callId. That keeps the
      // recorded history valid (a parked call gets a result, not an orphan) and
      // mirrors how a UI host will work — ask later, resume the same turn.
      ...(resume !== undefined ? { resume } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.summarize === true
        ? {
            summarizer: makeProviderSummarizer(provider),
            ...(host.summary !== undefined ? { priorSummary: host.summary } : {}),
            ...(options.summarizeAt !== undefined
              ? { summarizeAt: { atTokens: options.summarizeAt } }
              : {}),
          }
        : {}),
      onEvent,
    });

  let result = await call(host.messages);
  // A resumed turn is a *continuation*: sum the segments so the recorded cost
  // reflects every request the turn actually made.
  let usage = result.usage;
  while (result.reason === "awaiting_approval" && result.pendingApproval !== undefined) {
    const pending = result.pendingApproval;
    const decision = await decidePending(pending, options.autoApprove);
    await auditLog.record({
      threadId: host.threadId,
      turnId,
      kind: "approval",
      cwd: host.cwd,
      tool: pending.tool.name,
      risk: pending.tool.risk,
      decision: decision === "approve" ? "approved" : "denied",
      args: summarizeArgs(pending.args),
    });
    result = await call(result.messages, { callId: pending.callId, decision });
    usage = {
      inputTokens: usage.inputTokens + result.usage.inputTokens,
      outputTokens: usage.outputTokens + result.usage.outputTokens,
      steps: usage.steps + result.usage.steps,
    };
  }

  host.messages = [...result.messages];
  for (const message of result.messages.slice(before + 1)) {
    await store.appendMessage(host.threadId, turnId, message);
  }
  await store.appendTurn(host.threadId, {
    turnId,
    reason: result.reason,
    usage,
  });

  // Persist a fresh summary so the next turn reuses it instead of paying again.
  if (
    result.summary !== undefined &&
    (host.summary === undefined || result.summary.frontier > host.summary.frontier)
  ) {
    await store.saveSummary(host.threadId, result.summary);
    host.summary = result.summary;
  }

  await recordToolAudit(host, turnId, trace);
  await auditLog.record({
    threadId: host.threadId,
    turnId,
    kind: "turn",
    cwd: host.cwd,
    reason: result.reason,
    tokens: { input: usage.inputTokens, output: usage.outputTokens },
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

/** One audit line per executed tool: what, in which workspace, how long, ok? */
async function recordToolAudit(host: Host, turnId: string, trace: readonly AgentEvent[]): Promise<void> {
  const results = new Map(
    trace
      .filter((event): event is Extract<AgentEvent, { type: "tool.result" }> => event.type === "tool.result")
      .map((event) => [event.callId, event]),
  );

  for (const event of trace) {
    if (event.type !== "tool.call") continue;
    const tool = host.tools.find((candidate) => candidate.name === event.name);
    const outcome = results.get(event.callId);
    await auditLog.record({
      threadId: host.threadId,
      turnId,
      kind: "tool",
      cwd: host.cwd,
      tool: event.name,
      ...(tool !== undefined ? { risk: tool.risk } : {}),
      ...(outcome !== undefined ? { ok: outcome.ok, durationMs: outcome.durationMs } : {}),
      args: summarizeArgs(event.args),
    });
  }
}

function summarizeArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {});
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Host decision for a parked call: auto-approve, deny without a TTY, or ask. */
async function decidePending(
  pending: ApprovalRequest,
  autoApprove: boolean,
): Promise<"approve" | "deny"> {
  if (autoApprove) {
    console.log(dim(`  (auto-approved) ${pending.tool.name}`));
    return "approve";
  }
  if (process.stdin.isTTY !== true) {
    console.log(red(`  no TTY to ask — denying ${pending.tool.name} (pass --yes to allow)`));
    return "deny";
  }
  const answer = await ask(
    `\n  ${yellow("approve")} ${pending.tool.name} ${dim(JSON.stringify(pending.args))} ? [y/N] `,
  );
  return /^y(es)?$/i.test(answer.trim()) ? "approve" : "deny";
}

function reportSession(host: Host): void {
  console.log(dim(`\n  session ${host.threadId}`));
  console.log(dim(`  store       ${storeKind} · ${store.describe()}`));
  console.log(dim(`  workspace   ${host.cwd}`));
  console.log(dim(`  events      ${host.tracePath}`));
  console.log(
    dim(`  continue    pnpm dev run "<task>" --resume ${host.threadId}`) +
      dim(`   (or: pnpm dev chat --resume ${host.threadId})`),
  );
}

async function runLive(
  task: string,
  options: TurnOptions,
  resumeId?: string,
  scenario: Scenario = resolveScenario(undefined),
): Promise<void> {
  const provider = openAIProviderFromEnv();
  console.log(dim(`provider ${provider.id} · scenario ${scenario.id} (${scenario.tools.length} tools)`));
  const host = await openHost(resumeId, provider.id, scenario, options.worktree === true);
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

async function runChat(
  options: TurnOptions,
  resumeId?: string,
  scenario: Scenario = resolveScenario(undefined),
): Promise<void> {
  const provider = openAIProviderFromEnv();
  console.log(dim(`provider ${provider.id} · scenario ${scenario.id} (${scenario.tools.length} tools)`));
  const host = await openHost(resumeId, provider.id, scenario, options.worktree === true);
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

  const tools = mediaScenario.tools;
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
      system: mediaScenario.systemPrompt,
      cwd: process.cwd(),
      onEvent: printEvent,
    });
    messages = result.messages;
  }
}

async function runEval(live: boolean): Promise<void> {
  const cases = await loadCases();
  const tools = mediaScenario.tools;
  const provider = live ? openAIProviderFromEnv() : undefined;

  if (live) {
    console.log(yellow(`live eval against ${provider?.id} — this costs tokens`));
  }

  const results = [];
  for (const item of cases) {
    results.push(
      await runCase(item, tools, {
        system: mediaScenario.systemPrompt,
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

async function showAudit(threadId: string | undefined): Promise<void> {
  const entries = await auditLog.read({
    ...(threadId !== undefined ? { threadId } : {}),
    limit: 25,
  });

  if (entries.length === 0) {
    console.log(dim("no audit entries yet — run a live turn first"));
    return;
  }

  const rows = entries.map((entry) => [
    new Date(entry.ts).toISOString().slice(11, 19),
    entry.threadId.slice(7, 19),
    entry.kind,
    entry.tool ?? entry.reason ?? "",
    entry.decision ?? (entry.ok === undefined ? "" : entry.ok ? "ok" : "fail"),
    entry.tokens !== undefined
      ? `${entry.tokens.input}/${entry.tokens.output}`
      : entry.durationMs !== undefined
        ? `${entry.durationMs}ms`
        : "",
  ]);
  const header = ["time", "thread", "kind", "what", "decision", "cost"];
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log(dim(`\nfile: ${auditLog.file}${threadId === undefined ? "" : ` · thread ${threadId}`}`));
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
      "  audit [thread]                             what ran, where, approved or not",
      "  replay <file.events.ndjson>                re-print a recorded event stream",
      "",
      "  --store jsonl|sqlite   where sessions live (default jsonl; sqlite is opt-in until the UI needs queries)",
      "  --scenario media|coding  which tool set + policy to ship (default media: 7 tools instead of 13)",
      "  --summarize [--summarize-at <tokens>]  compress old turns into a summary when the request is large (default 24k)",
      "  --worktree             run in an isolated git worktree (runs/worktrees/<thread>)",
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
  readonly scenario?: string;
  readonly summarizeAt?: number;
  readonly maxSteps?: number;
}

/**
 * Hand-rolled parsing because the CLI has four value-taking flags.
 * `--resume <id>` must consume its value, otherwise the id would be joined into
 * the task string (`run "放晴天" --resume thread_x` → task "放晴天 thread_x").
 */
function parseArgs(args: readonly string[]): ParsedArgs {
  const flags: string[] = [];
  const positional: string[] = [];
  let resume: string | undefined;
  let storeKindArg: string | undefined;
  let scenarioArg: string | undefined;
  let summarizeAt: number | undefined;
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
    if (arg === "--scenario") {
      scenarioArg = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      scenarioArg = arg.slice("--scenario=".length);
      continue;
    }
    if (arg === "--summarize-at") {
      summarizeAt = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--summarize-at=")) {
      summarizeAt = Number(arg.slice("--summarize-at=".length));
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
    ...(scenarioArg !== undefined ? { scenario: scenarioArg } : {}),
    ...(summarizeAt !== undefined && Number.isFinite(summarizeAt) ? { summarizeAt } : {}),
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
    summarize: flags.includes("--summarize"),
    worktree: flags.includes("--worktree"),
    ...(parsed.summarizeAt !== undefined ? { summarizeAt: parsed.summarizeAt } : {}),
    ...(parsed.maxSteps !== undefined ? { maxSteps: parsed.maxSteps } : {}),
  };

  if (parsed.store !== undefined && parsed.store !== "jsonl" && parsed.store !== "sqlite") {
    console.error(red(`unknown store: ${parsed.store} (expected jsonl or sqlite)`));
    process.exitCode = 1;
    return;
  }
  storeKind = parsed.store === "sqlite" ? "sqlite" : "jsonl";
  store = storeKind === "sqlite" ? new SqliteSessionStore(join(RUN_DIR, "sessions.db")) : new JsonlSessionStore(RUN_DIR);
  const scenario = resolveScenario(parsed.scenario);

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
    await runLive(task, options, resumeId, scenario);
    return;
  }

  if (command === "chat") {
    await runChat(options, resumeId, scenario);
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

  if (command === "audit") {
    await showAudit(positional[0]);
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
