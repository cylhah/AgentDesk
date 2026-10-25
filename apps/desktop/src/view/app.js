/**
 * The view half of the host/view split.
 *
 * It knows nothing about providers, tools or sessions on disk — it consumes
 * `AgentEvent` (live over SSE, historical over the bridge) and renders it.
 * Everything privileged goes through `rpc()`, which is the only door into the
 * host; swapping HTTP for Electron's ipcRenderer or CEF's JS bridge changes
 * this function, not the rendering.
 */

const params = new URLSearchParams(location.search);
const token = params.get("token") ?? sessionStorage.getItem("agentdesk:token") ?? "";
if (params.get("token")) sessionStorage.setItem("agentdesk:token", params.get("token"));

/** Present only inside the Electron shell (preload.cjs). Its absence = plain browser. */
const shell = window.agentdeskShell ?? null;

const timeline = document.getElementById("timeline");
const sessionsEl = document.getElementById("sessions");
const dot = document.getElementById("dot");
const conn = document.getElementById("conn");
const seqinfo = document.getElementById("seqinfo");
const tokensEl = document.getElementById("tokens");
const metricsEl = document.getElementById("metrics");
const metricsBody = document.getElementById("metrics-body");
const metricsToggle = document.getElementById("metrics-toggle");
const runForm = document.getElementById("run-form");
const runTask = document.getElementById("run-task");
const runSubmit = document.getElementById("run-submit");

let lastSeq = 0;
let tokens = 0;
let stickToBottom = true;
let liveBubble = null;

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
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
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
      liveBubble = null;
      append(el("div", "turn-divider", `turn ${event.turnId.slice(5, 13)}`));
      break;
    }
    case "message.delta": {
      if (!event.text) break;
      if (!liveBubble) {
        liveBubble = el("div", "bubble asst");
        liveBubble.append(el("div", "tag", "assistant"), el("div", "live", ""));
        append(liveBubble);
      }
      liveBubble.querySelector(".live").textContent += event.text;
      break;
    }
    case "message.complete": {
      if (!event.text) break;
      if (liveBubble) {
        liveBubble.querySelector(".live").textContent = event.text;
        liveBubble = null;
      } else {
        const bubble = el("div", "bubble asst");
        bubble.append(el("div", "tag", "assistant"), el("div", null, event.text));
        append(bubble);
      }
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
      const out = timeline.querySelector(`.tool[data-call-id="${event.callId}"] .out`);
      const text = `${event.ok ? "✓" : "✗"} ${event.output.length > 400 ? `${event.output.slice(0, 400)}…` : event.output}`;
      if (out) {
        out.textContent = text;
        out.classList.add(event.ok ? "ok" : "bad");
      } else {
        append(el("div", "note", text));
      }
      break;
    }
    case "tool.approval_required": {
      pendingApprovals.set(event.callId, {
        name: event.name,
        args: event.args,
        choice: "approve",
      });
      renderApprovalPanel();
      break;
    }
    case "tool.approval_resolved": {
      pendingApprovals.delete(event.callId);
      renderApprovalPanel();
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
        el(
          "div",
          "note",
          `usage ${event.inputTokens} in / ${event.outputTokens} out${event.source ? ` (${event.source})` : ""}`,
        ),
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

/**
 * Pending confirm calls. A single step can park several (the loop stops before
 * executing any of them), so the panel is a small queue: every row defaults to
 * approve, and one submit sends the whole batch — the host rejects partial
 * batches because unresolved calls would stay in the history without results.
 */
const pendingApprovals = new Map();

function renderApprovalPanel() {
  document.getElementById("approval")?.remove();
  if (pendingApprovals.size === 0) return;

  const panel = el("div", "approval");
  panel.id = "approval";
  panel.append(
    el("div", null, `⏸ 待确认 ${pendingApprovals.size} 项`),
    el("div", "note", "批准后宿主会原地继续这个 turn（不是重跑）"),
  );

  for (const [callId, entry] of pendingApprovals) {
    const row = el("div", "approval-row");
    row.append(el("span", "tag", entry.name), el("span", "args", short(entry.args, 80)));

    const buttons = el("div", "approval-actions");
    for (const [label, decision, cls] of [
      ["批准", "approve", "ok"],
      ["拒绝", "deny", "bad"],
    ]) {
      const button = el("button", `btn ${cls} ${entry.choice === decision ? "active" : ""}`, label);
      button.onclick = () => {
        entry.choice = decision;
        renderApprovalPanel();
      };
      buttons.append(button);
    }
    row.append(buttons);
    panel.append(row);
  }

  const submit = el("button", "btn", `提交 ${pendingApprovals.size} 项决定`);
  submit.onclick = async () => {
    submit.disabled = true;
    const decisions = [...pendingApprovals.entries()].map(([callId, entry]) => ({
      callId,
      decision: entry.choice,
    }));
    try {
      // In the shell the preload is the privileged path; in a browser it is RPC.
      if (shell) await shell.resolveApproval(decisions);
      else await rpc("turn.resolve", { decisions });
    } catch (error) {
      append(el("div", "note bad", `resolve 失败：${error.message}`));
      submit.disabled = false;
    }
  };
  panel.append(submit);
  append(panel);
}

function connect() {
  const query = new URLSearchParams({ since: String(lastSeq) });
  if (token) query.set("token", token);
  const source = new EventSource(`/events?${query.toString()}`);

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

const SVG_NS = "http://www.w3.org/2000/svg";

/** Minimal trend line: a regression should be visible without reading numbers. */
function sparkline(values) {
  if (values.length < 2) {
    return el("div", "note", "至少两次运行才有趋势");
  }

  const width = 240;
  const height = 44;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);

  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * (width - 4) + 2;
      const y = height - 3 - ((value - min) / span) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const polyline = document.createElementNS(SVG_NS, "polyline");
  polyline.setAttribute("points", points);
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", "#38bdf8");
  polyline.setAttribute("stroke-width", "1.5");
  polyline.setAttribute("stroke-linejoin", "round");
  svg.append(polyline);
  return svg;
}

/** Recorded eval runs: pass rate, cost and latency — the "three tables", in one place. */
function renderMetrics(runs) {
  metricsBody.replaceChildren();

  if (!runs || runs.length === 0) {
    metricsBody.append(
      el("div", "empty", "还没有记录。跑 pnpm eval --live --record，然后回来点「度量」。"),
    );
    return;
  }

  const maxTokens = Math.max(
    ...runs.map((run) => run.summary.inputTokens + run.summary.outputTokens),
    1,
  );
  const table = el("table");
  const head = el("tr");
  for (const label of ["时间", "模型", "通过", "tokens", "p50", "flags"]) {
    head.append(el("th", null, label));
  }
  table.append(head);

  for (const run of [...runs].reverse()) {
    const tokens = run.summary.inputTokens + run.summary.outputTokens;
    const row = el("tr");
    row.append(
      el("td", null, new Date(run.ts).toISOString().slice(5, 16).replace("T", " ")),
      el("td", null, run.model.replace("openai:", "")),
      el(
        "td",
        run.summary.passed === run.summary.total ? "pass" : "fail",
        `${run.summary.passed}/${run.summary.total}`,
      ),
    );
    const tokenCell = el("td");
    const bar = el("span", "bar");
    bar.style.width = `${Math.max(4, Math.round((tokens / maxTokens) * 60))}px`;
    tokenCell.append(bar, document.createTextNode(tokens.toLocaleString()));
    row.append(tokenCell);
    row.append(el("td", null, `${run.summary.p50Ms}ms`));
    row.append(
      el(
        "td",
        "note",
        [
          run.live ? "live" : "scripted",
          run.flags?.suite !== undefined && run.flags.suite !== "media" ? run.flags.suite : "",
          run.flags?.maxContextTokens !== undefined ? `ctx=${run.flags.maxContextTokens}` : "",
          run.flags?.summarize === true ? "summarize" : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    );
    table.append(row);
  }
  metricsBody.append(table);

  const tokenSeries = runs.map((run) => run.summary.inputTokens + run.summary.outputTokens);
  const latencySeries = runs.map((run) => run.summary.p50Ms);
  const charts = el("div", "charts");
  for (const [label, series, unit] of [
    ["tokens / run", tokenSeries, ""],
    ["p50 latency", latencySeries, "ms"],
  ]) {
    const block = el("div", "chart");
    block.append(el("span", "label", label), sparkline(series));
    block.append(
      el(
        "span",
        "range",
        `${Math.min(...series).toLocaleString()}${unit} … ${Math.max(...series).toLocaleString()}${unit}`,
      ),
    );
    charts.append(block);
  }
  metricsBody.append(charts);

  const latest = runs[runs.length - 1];
  metricsBody.append(el("h2", null, `最近一次（${new Date(latest.ts).toISOString().slice(0, 16).replace("T", " ")}）`));
  const detail = el("table");
  const dhead = el("tr");
  for (const label of ["case", "结果", "steps", "tokens", "耗时"]) dhead.append(el("th", null, label));
  detail.append(dhead);
  for (const entry of latest.cases) {
    const row = el("tr");
    row.append(
      el("td", null, entry.id),
      el("td", entry.ok ? "pass" : "fail", entry.ok ? "PASS" : "FAIL"),
      el("td", null, String(entry.steps)),
      el("td", null, String(entry.inputTokens + entry.outputTokens)),
      el("td", null, `${entry.durationMs}ms`),
    );
    detail.append(row);
  }
  metricsBody.append(detail);
}

async function toggleMetrics() {
  if (!metricsEl.hidden) {
    metricsEl.hidden = true;
    timeline.hidden = false;
    metricsToggle.textContent = "度量";
    return;
  }

  metricsToggle.disabled = true;
  try {
    const runs = await rpc("eval.history", { limit: 20 });
    renderMetrics(runs);
    metricsEl.hidden = false;
    timeline.hidden = true;
    metricsToggle.textContent = "时间线";
  } catch (error) {
    metricsBody.replaceChildren(el("div", "empty bad", `读取评测历史失败：${error.message}`));
    metricsEl.hidden = false;
    timeline.hidden = true;
    metricsToggle.textContent = "时间线";
  } finally {
    metricsToggle.disabled = false;
  }
}

/**
 * Starting a turn from the dashboard is a desktop affordance: the person at the
 * machine *is* the operator. The view still cannot call tools — it asks the host
 * to run a task, exactly like `pnpm dev run "…"` does.
 */
async function submitTask(event) {
  event.preventDefault();
  const task = runTask.value.trim();
  if (task.length === 0) return;

  runTask.disabled = true;
  runSubmit.disabled = true;
  runSubmit.textContent = "运行中…";
  try {
    await rpc("turn.start", { task });
    runTask.value = "";
  } catch (error) {
    append(el("div", "note bad", `启动失败：${error.message}`));
  } finally {
    runTask.disabled = false;
    runSubmit.disabled = false;
    runSubmit.textContent = "运行";
    runTask.focus();
  }
}

async function bootstrap() {
  // Inside the shell the host runs local-only with --no-auth, and the preload
  // is the privileged surface. In a browser, a token is required.
  if (!token && !shell) {
    timeline.replaceChildren(
      el(
        "div",
        "empty",
        "缺少 token：请用终端里打印的 URL 打开（形如 http://127.0.0.1:4780/?token=…），或加 --no-auth 启动。",
      ),
    );
    setConnection("offline", "未授权");
    return;
  }

  connect();
  void loadSessions();
  metricsToggle?.addEventListener("click", () => void toggleMetrics());
  runForm?.addEventListener("submit", (event) => void submitTask(event));

  if (shell) {
    try {
      const info = await shell.info();
      const badge = document.getElementById("shell");
      if (badge) {
        badge.textContent = `shell · Electron ${info.electron} / Chromium ${String(info.chrome).split(".")[0]}`;
        badge.title = `${info.platform} · node ${info.node} · ${info.host}`;
      }
    } catch {
      // information only; never block the dashboard on it
    }
  }

  // First-run hint: without a key the host can serve history but cannot run a turn.
  try {
    const host = await rpc("host.info");
    if (host.providerConfigured === false) {
      const hint = el("div", "approval");
      hint.append(
        el("div", null, "未配置模型 key：可以浏览历史与回放，但不能发起新的回合。"),
        el(
          "div",
          "note",
          "在应用目录建一个 .env，写 OPENAI_API_KEY=sk-…（可选 OPENAI_BASE_URL / OPENAI_MODEL），然后重启。",
        ),
      );
      timeline.prepend(hint);
    }
  } catch {
    // host.info is best-effort
  }

  // The page may open after a turn already parked — show the buttons anyway.
  try {
    const state = await rpc("turn.state");
    for (const entry of state.pending ?? []) {
      pendingApprovals.set(entry.callId, { name: entry.name, args: entry.args, choice: "approve" });
    }
    renderApprovalPanel();
  } catch {
    // host started without --run: nothing to settle
  }
}

void bootstrap();
