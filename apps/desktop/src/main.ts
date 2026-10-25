import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentEventSchema, type AgentEvent } from "@agentdesk/protocol";
import { EventBroker } from "@agentdesk/eventstream";
import { JsonlSessionStore, SqliteSessionStore } from "@agentdesk/store";
import { startHostServer } from "./server";

/**
 * Desktop host entry point.
 *
 * Today the "view" is a browser tab pointed at this server; the transport is
 * SSE + HTTP. An Electron main process or a CEF shell only replaces how
 * `/events` is delivered and how `/api/rpc` reaches the host — the HMI, the
 * event schema and the bridge contract stay identical. That is the point of
 * building this layer first: the native boundary is a transport detail.
 */
interface Args {
  readonly port: number;
  readonly replay?: string;
  readonly store: "jsonl" | "sqlite";
}

function parseArgs(argv: readonly string[]): Args {
  let port = 4780;
  let replay: string | undefined;
  let store: "jsonl" | "sqlite" = "jsonl";

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
      const value = argv[index + 1];
      store = value === "sqlite" ? "sqlite" : "jsonl";
      index += 1;
    }
  }
  return { port: Number.isFinite(port) ? port : 4780, store, ...(replay !== undefined ? { replay } : {}) };
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

const args = parseArgs(process.argv.slice(2));
const store =
  args.store === "sqlite"
    ? new SqliteSessionStore(resolve("runs/sessions/sessions.db"))
    : new JsonlSessionStore(resolve("runs/sessions"));

const broker = new EventBroker();
const server = await startHostServer({
  store,
  broker,
  port: args.port,
  ...(args.replay !== undefined ? { currentThreadId: args.replay } : {}),
});

console.log(`agentdesk host  ${server.url}`);
console.log(`store ${args.store} · sessions ${store.describe()}`);

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
