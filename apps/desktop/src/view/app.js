/**
 * The view half of the host/view split.
 *
 * It knows nothing about providers, tools or sessions on disk — it consumes
 * `AgentEvent` (live over SSE, historical over the bridge) and renders it.
 * Everything privileged goes through `rpc()`, which is the only door into the
 * host; swapping HTTP for Electron's ipcRenderer or CEF's JS bridge changes
 * this function, not the rendering.
 */

const timeline = document.getElementById("timeline");
const sessionsEl = document.getElementById("sessions");
const dot = document.getElementById("dot");
const conn = document.getElementById("conn");
const seqinfo = document.getElementById("seqinfo");
const tokensEl = document.getElementById("tokens");

let lastSeq = 0;
let tokens = 0;
let stickToBottom = true;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const short = (value, max = 160) => {
  const text = JSON.stringify(value ?? {});
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

async function rpc(method, params) {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error ?? "rpc failed");
  return payload.result;
}

function atBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
}

function append(node) {
  const empty = timeline.querySelector(".empty");
  if (empty) empty.remove();
  timeline.append(node);
  if (stickToBottom) window.scrollTo({ top: document.body.scrollHeight });
}

window.addEventListener("scroll", () => {
  stickToBottom = atBottom();
});

function setConnection(state, text) {
  dot.className = `dot ${state}`;
  conn.textContent = text;
}

function renderEvent(event) {
  switch (event.type) {
    case "turn.start": {
      append(el("div", "turn-divider", `turn ${event.turnId.slice(5, 13)}`));
      break;
    }
    case "message.complete": {
      if (!event.text) break;
      const bubble = el("div", "bubble asst");
      bubble.append(el("div", "tag", "assistant"), el("div", null, event.text));
      append(bubble);
      break;
    }
    case "tool.call": {
      const card = el("div", "tool");
      const head = el("div", "head");
      head.append(el("span", "name", event.name), el("span", "args", short(event.args)));
      card.append(head, el("div", "out", "运行中…"));
      card.dataset.callId = event.callId;
      append(card);
      break;
    }
    case "tool.result": {
      const card = timeline.querySelector(`.tool[data-call-id="${event.callId}"] .out`);
      const text = `${event.ok ? "✓" : "✗"} ${event.output.length > 400 ? `${event.output.slice(0, 400)}…` : event.output}`;
      if (card) {
        card.textContent = text;
        card.classList.add(event.ok ? "ok" : "bad");
      } else {
        append(el("div", "note", text));
      }
      break;
    }
    case "tool.approval_required": {
      const banner = el("div", "approval");
      banner.textContent = `⏸ 需要确认：${event.name} ${short(event.args)}`;
      append(banner);
      break;
    }
    case "tool.approval_resolved": {
      append(
        el(
          "div",
          "note",
          event.decision === "approve" ? `✓ 已批准 ${event.name}` : `✗ 已拒绝 ${event.name}`,
        ),
      );
      break;
    }
    case "usage": {
      tokens += event.inputTokens + event.outputTokens;
      tokensEl.textContent = `${tokens.toLocaleString()} tokens`;
      append(
        el("div", "note", `usage ${event.inputTokens} in / ${event.outputTokens} out${event.source ? ` (${event.source})` : ""}`),
      );
      break;
    }
    case "context.summarized":
      append(el("div", "note", `⇣ 摘要 ${event.summarizedMessages} 条旧消息 → ${event.tokensAfter} tokens`));
      break;
    case "context.compacted":
      append(el("div", "note", `⇣ 压缩 ${event.tokensBefore} → ${event.tokensAfter} tokens`));
      break;
    case "error":
      append(el("div", "note bad", `! ${event.message}`));
      break;
    case "turn.end": {
      const line = el("div", "end");
      line.append(el("span", "tag", "⏹ "), el("span", "reason", event.reason));
      append(line);
      break;
    }
    default:
      break;
  }
}

function connect() {
  const source = new EventSource(`/events?since=${lastSeq}`);

  source.onopen = () => setConnection("online", "已连接 · SSE");
  source.onerror = () => setConnection("offline", "断开，自动重连…");

  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (message.lastEventId) {
        lastSeq = Number(message.lastEventId);
        seqinfo.textContent = `seq ${lastSeq}`;
      }
      renderEvent(event);
    } catch {
      // ignore malformed frame
    }
  };

  return source;
}

async function loadSessions() {
  try {
    const sessions = await rpc("session.list");
    sessionsEl.replaceChildren();
    for (const session of sessions.slice(0, 20)) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.append(
        el("span", null, session.firstUserText.slice(0, 24) || "(empty)"),
        el("small", null, `${session.threadId.slice(7, 17)} · ${session.turns} turns`),
      );
      button.onclick = () => void loadSession(session.threadId);
      item.append(button);
      sessionsEl.append(item);
    }
  } catch (error) {
    sessionsEl.append(el("li", "note bad", `会话读取失败：${error.message}`));
  }
}

async function loadSession(threadId) {
  const detail = await rpc("session.get", { threadId });
  timeline.replaceChildren();
  tokens = detail.turns.reduce(
    (sum, turn) => sum + turn.usage.inputTokens + turn.usage.outputTokens,
    0,
  );
  tokensEl.textContent = `${tokens.toLocaleString()} tokens`;

  append(el("div", "turn-divider", `历史会话 ${threadId.slice(7, 17)}`));
  for (const item of detail.items) {
    switch (item.kind) {
      case "user_message":
        append(el("div", "bubble user", item.text));
        break;
      case "assistant_message":
        append(el("div", "bubble asst", item.text));
        break;
      case "tool_call": {
        const card = el("div", "tool");
        const head = el("div", "head");
        head.append(el("span", "name", item.call.name), el("span", "args", short(item.call.args)));
        card.append(head, el("div", "out", ""));
        card.dataset.callId = item.call.id;
        append(card);
        break;
      }
      case "tool_result": {
        const out = timeline.querySelector(`.tool[data-call-id="${item.callId}"] .out`);
        if (out) {
          out.textContent = `${item.ok ? "✓" : "✗"} ${item.output.slice(0, 400)}`;
          out.classList.add(item.ok ? "ok" : "bad");
        }
        break;
      }
      default:
        break;
    }
  }
}

window.addEventListener("beforeunload", () => {
  // EventSource closes itself; nothing else to release here.
});

connect();
void loadSessions();
