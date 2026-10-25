import { EventBroker, parseSseChunk, toSseFrame } from "@agentdesk/eventstream";
import { describe, expect, it, vi } from "vitest";

const turnStart = (turnId: string): Parameters<EventBroker["publish"]>[0] => ({
  type: "turn.start",
  turnId,
  ts: 1,
});

describe("EventBroker", () => {
  it("numbers events monotonically and streams them to subscribers", () => {
    const broker = new EventBroker();
    const seen: number[] = [];
    const stop = broker.subscribe((frame) => seen.push(frame.seq));

    broker.publish(turnStart("turn_1"));
    broker.publish(turnStart("turn_2"));
    stop();
    broker.publish(turnStart("turn_3"));

    expect(seen).toEqual([1, 2]);
    expect(broker.lastSeq).toBe(3);
  });

  it("replays exactly the gap after `since` — the reconnect contract", () => {
    const broker = new EventBroker();
    for (const id of ["turn_1", "turn_2", "turn_3"]) broker.publish(turnStart(id));

    expect(broker.since(0)).toHaveLength(3);
    expect(broker.since(2)).toHaveLength(1);
    expect(broker.since(2)[0]?.event).toMatchObject({ turnId: "turn_3" });
    expect(broker.since(3)).toEqual([]);
  });

  it("keeps only the most recent events in the replay buffer", () => {
    const broker = new EventBroker({ bufferSize: 2 });
    for (const id of ["turn_1", "turn_2", "turn_3", "turn_4"]) broker.publish(turnStart(id));

    const replay = broker.since(0);
    expect(replay.map((frame) => frame.seq)).toEqual([3, 4]);
  });

  it("reports truncation when the requested gap was already evicted", () => {
    const broker = new EventBroker({ bufferSize: 2 });
    for (const id of ["turn_1", "turn_2", "turn_3", "turn_4"]) broker.publish(turnStart(id));

    expect(broker.replay(0).truncated).toBe(false); // "from what you still have"
    expect(broker.replay(3).truncated).toBe(false); // contiguous
    expect(broker.replay(1).truncated).toBe(true); // seq 2 is gone
  });
});

describe("SSE framing", () => {
  it("round-trips events through the wire format", () => {
    const broker = new EventBroker();
    const frame = broker.publish(turnStart("turn_9"));
    const text = toSseFrame(frame);

    expect(text).toContain("id: 1");
    expect(parseSseChunk(text)).toEqual([frame.event]);
  });

  it("ignores malformed frames instead of dropping the stream", () => {
    const chunk = 'data: {"type":"turn.start","turnId":"t","ts":1}\n\ndata: {oops\n\n';
    expect(parseSseChunk(chunk)).toHaveLength(1);
  });
});
