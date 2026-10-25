import {
  createBridgeClient,
  createBridgeServer,
  createHostTransport,
  createLinkedChannelIo,
  createViewTransport,
} from "@agentdesk/bridge";
import { describe, expect, it } from "vitest";

describe("channel transport", () => {
  it("routes a call one way and answers on the other channel", async () => {
    const [hostIo, viewIo] = createLinkedChannelIo();
    let handled = 0;
    const seenByView: string[] = [];

    const server = createBridgeServer(
      {
        "host.info": () => {
          handled += 1;
          return { ok: true };
        },
      },
      createHostTransport(hostIo),
    );
    const client = createBridgeClient(createViewTransport(viewIo));

    const off = viewIo.on("agentdesk:to-view", (message) => seenByView.push(message.kind));
    await expect(client.call("host.info")).resolves.toEqual({ ok: true });
    off();

    // Handled once (no echo loop), and the view only ever sees the response.
    expect(handled).toBe(1);
    expect(seenByView).toEqual(["response"]);
    client.dispose();
    server.dispose();
  });

  it("carries an error across the channel instead of throwing", async () => {
    const [hostIo, viewIo] = createLinkedChannelIo();
    const server = createBridgeServer(
      {
        explode: () => {
          throw new Error("nope");
        },
      },
      createHostTransport(hostIo),
    );
    const client = createBridgeClient(createViewTransport(viewIo));

    await expect(client.call("explode")).rejects.toThrow(/nope/);
    client.dispose();
    server.dispose();
  });

  it("keeps two view instances independent", async () => {
    const [hostIo, viewIoA] = createLinkedChannelIo();
    const [, viewIoB] = createLinkedChannelIo();

    const server = createBridgeServer(
      { ping: () => "pong" },
      createHostTransport(hostIo),
    );
    const a = createBridgeClient(createViewTransport(viewIoA));
    const b = createBridgeClient(createViewTransport(viewIoB));

    await expect(a.call("ping")).resolves.toBe("pong");
    // B is on a different channel pair; its call must time out, not resolve.
    const client = createBridgeClient(createViewTransport(viewIoB), { timeoutMs: 20 });
    await expect(client.call("ping")).rejects.toThrow(/timed out/);

    a.dispose();
    b.dispose();
    client.dispose();
    server.dispose();
  });
});
