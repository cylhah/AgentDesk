import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AgentEvent } from "@agentdesk/protocol";
import { createBridgeServer, type BridgeMessage, type BridgeRequest } from "@agentdesk/bridge";
import { SSE_HEADERS, toSseFrame, type EventBroker } from "@agentdesk/eventstream";
import { deriveItems, type SessionStore } from "@agentdesk/store";
import { EvalHistory } from "@agentdesk/eval";
import type { TurnRunner } from "./turn";

export interface HostServerOptions {
  readonly store: SessionStore;
  readonly broker: EventBroker;
  readonly port?: number;
  readonly host?: string;
  /** Session shown by the HMI on load (usually the one being replayed). */
  readonly currentThreadId?: string;
  /**
   * When set, `/events` and `/api/rpc` require `Authorization: Bearer <token>`
   * or `?token=`. Static assets and `/health` stay public: they carry no data.
   * Localhost is not a security boundary — any local process can connect.
   */
  readonly token?: string;
  /** Present when the host was started with `--run`: enables approval resolving. */
  readonly runner?: TurnRunner;
}

export interface HostServer {
  readonly url: string;
  close(): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/**
 * Lets the view talk to the host over plain HTTP while keeping the bridge's
 * request/response contract. One instance per HTTP call: the transport is
 * stateless, which is exactly what a browser tab needs after a reload.
 */
class HttpBridgeCall {
  private resolveResponse: ((message: BridgeMessage) => void) | undefined;
  private handler: ((message: BridgeRequest) => void) | undefined;

  readonly transport = {
    send: (message: BridgeMessage): void => {
      if (message.kind === "response") this.resolveResponse?.(message);
    },
    onMessage: (handler: (message: BridgeRequest) => void): (() => void) => {
      this.handler = handler;
      return () => {
        this.handler = undefined;
      };
    },
  };

  call(request: BridgeRequest): Promise<BridgeMessage> {
    return new Promise((resolve) => {
      this.resolveResponse = resolve;
      this.handler?.(request);
    });
  }
}

export async function startHostServer(options: HostServerOptions): Promise<HostServer> {
  const { store, broker } = options;
  const port = options.port ?? 4780;
  const host = options.host ?? "127.0.0.1";

  const viewDir = new URL("./view/", import.meta.url);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    try {
      if (url.pathname === "/") {
        await sendFile(response, new URL("index.html", viewDir), "text/html; charset=utf-8");
        return;
      }

      if (url.pathname === "/app.js") {
        await sendFile(response, new URL("app.js", viewDir), "text/javascript; charset=utf-8");
        return;
      }

      if (url.pathname === "/events") {
        if (!authorized(request, url, options.token)) {
          response.writeHead(401, JSON_HEADERS).end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }
        const lastEventId = request.headers["last-event-id"];
        streamEvents(
          Array.isArray(lastEventId) ? lastEventId[0] : lastEventId,
          url.searchParams.get("since"),
          response,
          broker,
        );
        return;
      }

      if (url.pathname === "/api/rpc" && request.method === "POST") {
        if (!authorized(request, url, options.token)) {
          response.writeHead(401, JSON_HEADERS).end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }
        const body = await readBody(request);
        const parsed = JSON.parse(body) as { method?: string; params?: unknown };
        if (typeof parsed.method !== "string") {
          response.writeHead(400, JSON_HEADERS).end(JSON.stringify({ ok: false, error: "method required" }));
          return;
        }

        const call = new HttpBridgeCall();
        const bridge = createBridgeServer(
          buildHandlers(store, broker, options.currentThreadId, options.runner),
          call.transport,
        );
        const result = await call.call({
          kind: "request",
          id: "http",
          method: parsed.method,
          params: parsed.params,
        });
        bridge.dispose();
        response.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/health") {
        response
          .writeHead(200, JSON_HEADERS)
          .end(JSON.stringify({ ok: true, lastSeq: broker.lastSeq }));
        return;
      }

      response.writeHead(404, JSON_HEADERS).end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (error) {
      response
        .writeHead(500, JSON_HEADERS)
        .end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return {
    url: `http://${host}:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function streamEvents(
  lastEventId: string | undefined,
  sinceParam: string | null,
  response: ServerResponse,
  broker: EventBroker,
): void {
  const since = Number(lastEventId ?? sinceParam ?? "0");
  response.writeHead(200, { ...SSE_HEADERS });

  // A comment frame flushes headers immediately: EventSource fires `open` now,
  // not on the first real event.
  response.write(": connected\n\n");

  const replay = broker.replay(Number.isFinite(since) ? since : 0);
  if (replay.truncated) {
    // The client fell behind the buffer; say so instead of pretending the
    // timeline is complete.
    response.write(`: gap after ${since}\n\n`);
  }
  for (const frame of replay.frames) {
    response.write(toSseFrame(frame));
  }

  const unsubscribe = broker.subscribe((frame) => {
    response.write(toSseFrame(frame));
  });

  // Proxies close idle connections; a heartbeat keeps the stream alive.
  const heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000);

  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function sendFile(response: ServerResponse, file: URL, type: string): Promise<void> {
  const content = await readFile(file, "utf8");
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(content);
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The whole privileged surface the view may touch. Read-only by design. */
function buildHandlers(
  store: SessionStore,
  broker: EventBroker,
  currentThreadId: string | undefined,
  runner: TurnRunner | undefined,
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    "host.info": async () => ({
      lastSeq: broker.lastSeq,
      store: store.describe(),
      currentThreadId: currentThreadId ?? null,
    }),

    "session.list": async () => await store.list(),

    "session.get": async (params) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (typeof threadId !== "string") throw new Error("threadId required");
      const loaded = await store.load(threadId);
      return {
        header: loaded.header,
        messages: loaded.messages,
        items: deriveItems(loaded.messages),
        turns: loaded.turns,
      };
    },

    "events.since": async (params) => {
      const since = (params as { since?: number } | undefined)?.since ?? 0;
      return broker.since(typeof since === "number" ? since : 0).map((frame) => ({
        seq: frame.seq,
        event: frame.event as AgentEvent,
      }));
    },

    // Present only when the host was started with `--run`. The view can resolve
    // a parked call; it still cannot submit a task.
    "turn.state": async () => runner?.state() ?? { threadId: null, pending: null, reason: null },

    /** Recorded eval runs: the dashboard's "three tables" (pass rate / cost / latency). */
    "eval.history": async (params) => {
      const limit = (params as { limit?: number } | undefined)?.limit ?? 20;
      const runs = await new EvalHistory().read(typeof limit === "number" ? limit : 20);
      return runs;
    },

    "turn.resolve": async (params) => {
      if (runner === undefined) throw new Error("host was started without --run");
      const decision = (params as { decision?: string } | undefined)?.decision;
      if (decision !== "approve" && decision !== "deny") {
        throw new Error('decision must be "approve" or "deny"');
      }
      return await runner.resolve(decision);
    },
  };
}

function authorized(
  request: import("node:http").IncomingMessage,
  url: URL,
  token: string | undefined,
): boolean {
  if (token === undefined) return true;
  const header = request.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}
