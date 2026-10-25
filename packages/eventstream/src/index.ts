import type { AgentEvent } from "@agentdesk/protocol";

/**
 * One event with a monotonic sequence number.
 *
 * The sequence is the whole reconnect story: a UI that loses its connection
 * reconnects with `since=<last seen>` and gets exactly the gap, instead of
 * reloading the page or replaying the whole session.
 */
export interface SequencedEvent {
  readonly seq: number;
  readonly event: AgentEvent;
}

export interface BrokerOptions {
  /** How many recent events stay available for `since()` replay. */
  readonly bufferSize?: number;
}

type Listener = (frame: SequencedEvent) => void;

export class EventBroker {
  private seq = 0;
  private readonly buffer: SequencedEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly bufferSize: number;

  constructor(options: BrokerOptions = {}) {
    this.bufferSize = Math.max(1, options.bufferSize ?? 2_000);
  }

  get lastSeq(): number {
    return this.seq;
  }

  publish(event: AgentEvent): SequencedEvent {
    this.seq += 1;
    const frame: SequencedEvent = { seq: this.seq, event };
    this.buffer.push(frame);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const listener of this.listeners) listener(frame);
    return frame;
  }

  /**
   * Replay everything after `since`. `since = 0` means "from the beginning of
   * what is still buffered"; `since = lastSeq` means "nothing missed".
   *
   * `truncated` says the client asked for events that were already evicted —
   * silently continuing would hide a hole in the timeline from both the UI and
   * whoever debugs it later.
   */
  replay(since: number): { frames: SequencedEvent[]; truncated: boolean } {
    const firstBuffered = this.buffer[0]?.seq;
    const truncated =
      since > 0 && firstBuffered !== undefined && since < firstBuffered - 1;
    return {
      frames: this.buffer.filter((frame) => frame.seq > since),
      truncated,
    };
  }

  since(since: number): SequencedEvent[] {
    return this.replay(since).frames;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Server-Sent Events frame: `id:` is what the browser sends back as Last-Event-ID. */
export function toSseFrame(frame: SequencedEvent): string {
  return `id: ${frame.seq}\ndata: ${JSON.stringify(frame.event)}\n\n`;
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

/**
 * Minimal client-side reassembly, used by tests and by non-browser consumers of
 * the stream. Browsers do this natively via `EventSource`.
 */
export function parseSseChunk(chunk: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of chunk.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue;
    try {
      events.push(JSON.parse(dataLines.join("\n")) as AgentEvent);
    } catch {
      // ignore malformed frames; a broken frame must not kill the stream
    }
  }
  return events;
}
