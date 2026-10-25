/**
 * A typed request/response bridge between an untrusted view (the HMI, running
 * inside a web container) and a privileged host (Node, Electron main, or a
 * native shell over CEF's JS bridge).
 *
 * Deliberately transport-agnostic: today it runs over `postMessage`-style
 * in-process transports or HTTP; an Electron `ipcRenderer` adapter or a CEF
 * `window.cefBridge` adapter only has to implement `BridgeTransport`.
 *
 * What it must guarantee, because the view is untrusted:
 *   - the host never trusts a method name it did not register (no eval, no paths)
 *   - a failed handler becomes an error string, never an exception crossing the boundary
 *   - a call that is never answered times out instead of leaking a promise
 */
export interface BridgeRequest {
  readonly kind: "request";
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface BridgeResponse {
  readonly kind: "response";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export type BridgeMessage = BridgeRequest | BridgeResponse;

export interface BridgeTransport {
  send(message: BridgeMessage): void | Promise<void>;
  onMessage(handler: (message: BridgeMessage) => void): () => void;
}

export type BridgeHandler = (params: unknown, context: { method: string }) => unknown | Promise<unknown>;

export interface BridgeClientOptions {
  readonly timeoutMs?: number;
}

export interface BridgeClient {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Rejects every in-flight call; callers see an explicit error, not a hang. */
  dispose(): void;
}

export interface BridgeServer {
  dispose(): void;
}

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `call_${counter}`;
};

export function createBridgeClient(
  transport: BridgeTransport,
  options: BridgeClientOptions = {},
): BridgeClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const unsubscribe = transport.onMessage((message) => {
    if (message.kind !== "response") return;
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? "bridge call failed"));
  });

  return {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId();
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge call timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });

      try {
        await transport.send({ kind: "request", id, method, params });
      } catch (error) {
        const entry = pending.get(id);
        if (entry !== undefined) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      return (await promise) as T;
    },

    dispose(): void {
      unsubscribe();
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error("bridge disposed"));
      }
    },
  };
}

export function createBridgeServer(
  handlers: Readonly<Record<string, BridgeHandler>>,
  transport: BridgeTransport,
): BridgeServer {
  const unsubscribe = transport.onMessage((message) => {
    if (message.kind !== "request") return;
    const handler = handlers[message.method];

    if (handler === undefined) {
      void transport.send({
        kind: "response",
        id: message.id,
        ok: false,
        error: `unknown method: ${message.method}`,
      });
      return;
    }

    void Promise.resolve()
      .then(() => handler(message.params, { method: message.method }))
      .then(
        (result) =>
          transport.send({ kind: "response", id: message.id, ok: true, result }),
        (error: unknown) =>
          transport.send({
            kind: "response",
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
  });

  return { dispose: unsubscribe };
}

export * from "./channels";

/** Two linked in-memory transports — used by tests and by the CLI demo host. */
export function createLinkedTransports(): [BridgeTransport, BridgeTransport] {
  const aListeners = new Set<(message: BridgeMessage) => void>();
  const bListeners = new Set<(message: BridgeMessage) => void>();

  const make = (
    own: Set<(message: BridgeMessage) => void>,
    other: Set<(message: BridgeMessage) => void>,
  ): BridgeTransport => ({
    send(message) {
      // Async hop so handlers cannot observe half-delivered state.
      queueMicrotask(() => {
        for (const listener of other) listener(message);
      });
    },
    onMessage(handler) {
      own.add(handler);
      return () => {
        own.delete(handler);
      };
    },
  });

  return [make(aListeners, bListeners), make(bListeners, aListeners)];
}
