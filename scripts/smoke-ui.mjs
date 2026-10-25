// Smoke test for the dashboard host: static view, RPC over the bridge, SSE
// stream, and reconnect-by-sequence. Plain Node (no tsx) so it exercises the
// real server. Usage: node scripts/smoke-ui.mjs http://127.0.0.1:4780
const base = process.argv[2] ?? "http://127.0.0.1:4780";

const readSse = async (since, ms) => {
  const controller = new AbortController();
  const response = await fetch(`${base}/events?since=${since}`, { signal: controller.signal });
  const type = response.headers.get("content-type");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: false, value: undefined }), 150)),
    ]);
    if (chunk.done) break;
    if (chunk.value) {
      buffer += decoder.decode(chunk.value);
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const id = /^id:\s*(\d+)$/m.exec(block)?.[1];
        const data = /^data:\s*(.*)$/m.exec(block)?.[1];
        if (data) frames.push({ seq: Number(id), event: JSON.parse(data) });
      }
    }
  }
  controller.abort();
  return { type, frames };
};

const health = await (await fetch(`${base}/health`)).json();
const html = await (await fetch(`${base}/`)).text();
const rpc = await (
  await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "session.list" }),
  })
).json();

const live = await readSse(0, 2500);
const lastSeq = live.frames.at(-1)?.seq ?? 0;
const resumed = await readSse(lastSeq, 700);

console.log(
  JSON.stringify(
    {
      health,
      htmlBytes: html.length,
      htmlLooksRight: html.includes("AgentDesk") && html.includes("/app.js"),
      rpcOk: rpc.ok,
      rpcSessions: rpc.result?.length ?? 0,
      sseContentType: live.type,
      sseFrames: live.frames.length,
      firstSeq: live.frames[0]?.seq,
      lastSeq,
      eventTypes: [...new Set(live.frames.map((frame) => frame.event.type))],
      reconnectFrom: lastSeq,
      reconnectFrames: resumed.frames.length,
    },
    null,
    2,
  ),
);
