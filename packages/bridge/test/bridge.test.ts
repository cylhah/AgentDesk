import {
  createBridgeClient,
  createBridgeServer,
  createLinkedTransports,
  type BridgeTransport,
} from "@agentdesk/bridge";
import { describe, expect, it } from "vitest";

function setup(handlers: Parameters<typeof createBridgeServer>[0]) {
  const [hostSide, viewSide] = createLinkedTransports();
  const server = createBridgeServer(handlers, hostSide);
  const client = createBridgeClient(viewSide);
  return {
    client,
    dispose: () => {
      client.dispose();
      server.dispose();
    },
  };
}

describe("bridge", () => {
  it("dispatches a call to the registered handler", async () => {
    const { client, dispose } = setup({
      "session.list": () => [{ threadId: "thread_a" }],
    });

    await expect(client.call("session.list")).resolves.toEqual([{ threadId: "thread_a" }]);
    dispose();
  });

  it("passes params through unchanged", async () => {
    const { client, dispose } = setup({
      echo: (params) => params,
    });

    await expect(client.call("echo", { nested: [1, 2, 3] })).resolves.toEqual({
      nested: [1, 2, 3],
    });
    dispose();
  });

  it("rejects an unregistered method instead of running anything", async () => {
    const { client, dispose } = setup({});
    await expect(client.call("session.delete")).rejects.toThrow(/unknown method/);
    dispose();
  });

  it("turns a throwing handler into a rejection, not a crash across the boundary", async () => {
    const { client, dispose } = setup({
      boom: () => {
        throw new Error("handler exploded");
      },
    });

    await expect(client.call("boom")).rejects.toThrow(/handler exploded/);
    dispose();
  });

  it("handles concurrent calls independently", async () => {
    const { client, dispose } = setup({
      "math.double": (params) => {
        const value = (params as { value: number }).value;
        return value * 2;
      },
    });

    const results = await Promise.all([
      client.call<number>("math.double", { value: 1 }),
      client.call<number>("math.double", { value: 2 }),
      client.call<number>("math.double", { value: 3 }),
    ]);
    expect(results).toEqual([2, 4, 6]);
    dispose();
  });

  it("times out a call the host never answers", async () => {
    const silent: BridgeTransport = {
      send: () => undefined,
      onMessage: () => () => undefined,
    };
    const client = createBridgeClient(silent, { timeoutMs: 10 });

    await expect(client.call("never")).rejects.toThrow(/timed out/);
    client.dispose();
  });

  it("rejects in-flight calls on dispose so the view cannot hang", async () => {
    const silent: BridgeTransport = {
      send: () => undefined,
      onMessage: () => () => undefined,
    };
    const client = createBridgeClient(silent, { timeoutMs: 5_000 });
    const pending = client.call("never");
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });
});
