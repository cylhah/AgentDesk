import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentEventSchema, type AgentEvent } from "@agentdesk/protocol";
import { EventBroker } from "@agentdesk/eventstream";
import { AuditLog, JsonlSessionStore, SqliteSessionStore } from "@agentdesk/store";
import { resolveScenario } from "@agentdesk/tools";
import { startHostServer } from "./server";
import { TurnRunner } from "./turn";

/**
 * Desktop host entry point.
 *
 * Today the "view" is a browser tab pointed at this server; the transport is
 * SSE + HTTP. An Electron main process or a CEF shell only replaces how
 * `/events` is delivered and how `/api/rpc` reaches the host — the HMI, the
 * event schema and the bridge contract stay identical.
 */
interface Args {
  readonly port: number;
  readonly replay?: string;
  readonly store: "jsonl" | "sqlite";
  readonly run?: string;
  readonly scenario: string;
  readonly noAuth: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let port = 4780;
  let replay: string | undefined;
  let store: "jsonl" | "sqlite" = "jsonl";
  let run: string | undefined;
  let scenario = "media";
  let noAuth = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--port") {
      port = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--replay") {
      replay = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--store") {
      store = argv[index + 1] === "sqlite" ? "sqlite" : "jsonl";
      index += 1;
      continue;
    }
    if (arg === "--run") {
      run = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--scenario") {
      scenario = argv[index + 1] ?? "media";
      index += 1;
      continue;
    }
    if (arg === "--no-auth") noAuth = true;
  }

  return {
    port: Number.isFinite(port) ? port : 4780,
    store,
    scenario,
    noAuth,
    ...(replay !== undefined ? { replay } : {}),
    ...(run !== undefined ? { run } : {}),
  };
}

/** A recorded trace is either `<thread>` (looked up) or a path to `.events.ndjson`. */
async function loadTrace(replay: string): Promise<AgentEvent[]> {
  // Accept all the shapes a human might paste: a bare thread id, a file name in
  // runs/sessions, or a full path — with or without the `.events` suffix.
  const bare = replay.replace(/\.events$/, "").replace(/\.ndjson$/, "");
  const candidates = [
    resolve(replay),
    resolve("runs/sessions", replay),
    resolve("runs/sessions", `${bare}.events.ndjson`),
    resolve("runs/sessions", `${bare}.jsonl`),
  ];

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf8");
      const events: AgentEvent[] = [];
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed = AgentEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) events.push(parsed.data);
      }
      return events;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`cannot find trace: ${replay}`);
}

/**
 * Minimal `.env` support for the portable build: the packaged app has no shell
 * to export variables into, so a `.env` next to the executable is the first-run
 * path. Existing environment always wins — never overwrite a real key with a
 * stale file.
 */
async function loadDotEnv(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value;
  }
}

await loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const store =
  args.store === "sqlite"
    ? new SqliteSessionStore(resolve("runs/sessions/sessions.db"))
    : new JsonlSessionStore(resolve("runs/sessions"));

const broker = new EventBroker();
const scenario = resolveScenario(args.scenario);

const runner =
  args.run !== undefined
    ? new TurnRunner({
        store,
        broker,
        scenario,
        cwd: process.cwd(),
        summarize: true,
        audit: new AuditLog(resolve("runs/audit.ndjson")),
      })
    : undefined;

// Localhost is not a boundary: any local process can reach the port, so the
// data endpoints require a token that only the terminal knows.
const token = args.noAuth ? undefined : randomBytes(16).toString("hex");

const server = await startHostServer({
  store,
  broker,
  port: args.port,
  ...(args.replay !== undefined ? { currentThreadId: args.replay } : {}),
  ...(token !== undefined ? { token } : {}),
  ...(runner !== undefined ? { runner } : {}),
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("EADDRINUSE")) {
    throw new Error(`port ${args.port} is busy — pass --port <n> or stop the other host`);
  }
  throw error;
});

const url = token === undefined ? server.url : `${server.url}/?token=${token}`;
console.log(`agentdesk host  ${url}`);
if (token !== undefined) {
  console.log("token required for /events and /api/rpc (pass --no-auth to disable)");
}
console.log(
  `store ${args.store} · scenario ${scenario.id} (${scenario.tools.length} tools) · sessions ${store.describe()}`,
);

if (args.run !== undefined) {
  console.log(`running turn: ${args.run}`);
  runner
    ?.start(args.run)
    .then((state) => {
      if (state.pending.length > 0) {
        const names = state.pending.map((entry) => entry.name).join(", ");
        console.log(`parked for approval: ${names} — approve them in the dashboard`);
      } else {
        console.log(`turn finished: ${state.reason ?? "unknown"}`);
      }
    })
    .catch((error: unknown) => {
      console.error(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

if (args.replay !== undefined) {
  const events = await loadTrace(args.replay);
  console.log(`replaying ${events.length} events from ${args.replay}`);
  // Paced replay so the HMI shows a timeline instead of one instant dump.
  let index = 0;
  const timer = setInterval(() => {
    const event = events[index];
    if (event === undefined) {
      clearInterval(timer);
      console.log("replay finished — open the URL, or run a live turn and refresh");
      return;
    }
    broker.publish(event);
    index += 1;
  }, 120);
}

const shutdown = async (): Promise<void> => {
  await server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
