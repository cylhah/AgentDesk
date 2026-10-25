import type { BridgeMessage, BridgeTransport } from "./index";

/**
 * Channel-based transport, which is what every embedded container actually
 * offers: Electron `ipcRenderer/ipcMain`, WebView2 `postMessage`, CEF's message
 * router. Host and view get mirrored channel names, so a message never echoes
 * back to its sender.
 */
export interface ChannelIo {
  send(channel: string, message: BridgeMessage): void;
  on(channel: string, handler: (message: BridgeMessage) => void): () => void;
}

export interface ChannelNames {
  readonly toHost: string;
  readonly toView: string;
}

export const DEFAULT_CHANNELS: ChannelNames = {
  toHost: "agentdesk:to-host",
  toView: "agentdesk:to-view",
};

export function createHostTransport(io: ChannelIo, channels: ChannelNames = DEFAULT_CHANNELS): BridgeTransport {
  return {
    send: (message) => io.send(channels.toView, message),
    onMessage: (handler) => io.on(channels.toHost, handler),
  };
}

export function createViewTransport(io: ChannelIo, channels: ChannelNames = DEFAULT_CHANNELS): BridgeTransport {
  return {
    send: (message) => io.send(channels.toHost, message),
    onMessage: (handler) => io.on(channels.toView, handler),
  };
}

/** In-memory ChannelIo pair for tests and for running the host without a container. */
export function createLinkedChannelIo(): [ChannelIo, ChannelIo] {
  const listeners = new Map<string, Set<(message: BridgeMessage) => void>>([
    [DEFAULT_CHANNELS.toHost, new Set()],
    [DEFAULT_CHANNELS.toView, new Set()],
  ]);

  const io = (outChannel: string): ChannelIo => ({
    send: (channel, message) => {
      void outChannel;
      queueMicrotask(() => {
        for (const handler of listeners.get(channel) ?? []) handler(message);
      });
    },
    on: (channel, handler) => {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  });

  return [io(DEFAULT_CHANNELS.toView), io(DEFAULT_CHANNELS.toHost)];
}
