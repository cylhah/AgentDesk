const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { join } = require("node:path");

/**
 * Packaged shell: same window/preload contract as `main.cjs`, but the host is a
 * single bundled `host.mjs` next to this file (no tsx, no node_modules), and the
 * Electron binary re-runs itself as Node via ELECTRON_RUN_AS_NODE.
 */
const appRoot = __dirname;
const hostEntry = join(appRoot, "host.mjs");
// Portable layout: `.env`, `runs/` and the executable live side by side, so the
// whole folder can be moved or copied without losing data.
const dataDir = join(appRoot, "..", "..");

console.log(`electron ${process.versions.electron} · chromium ${process.versions.chrome}`);

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 4780;
      probe.close(() => resolvePort(port));
    });
  });
}

function startHost(port) {
  return new Promise((resolveUrl, reject) => {
    const child = spawn(process.execPath, [hostEntry, "--port", String(port), "--no-auth"], {
      cwd: dataDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    const timer = setTimeout(() => reject(new Error("host did not start within 30s")), 30_000);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      buffer += text;
      process.stdout.write(`[host] ${text}`);
      const match = /agentdesk host\s+(http:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolveUrl({ url: match[1].replace(/\/$/, ""), child });
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`[host] ${String(chunk)}`));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited early (code ${code})`));
    });
  });
}

let host = null;
let window = null;
let hostUrl = "";

async function boot() {
  const port = await freePort();
  const started = await startHost(port);
  host = started.child;
  hostUrl = started.url;

  ipcMain.handle("shell:info", () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    host: hostUrl,
  }));

  ipcMain.handle("shell:resolve-approval", async (_event, decisions) => {
    const response = await fetch(`${hostUrl}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "turn.resolve", params: { decisions } }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error ?? "resolve failed");
    return payload.result;
  });

  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0f14",
    title: "AgentDesk · 座舱媒体",
    webPreferences: {
      preload: join(appRoot, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadURL(hostUrl);
  console.log(`electron window ready: ${hostUrl}`);
}

app
  .whenReady()
  .then(boot)
  .catch((error) => {
    dialog.showErrorBox("AgentDesk 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  });

app.on("window-all-closed", () => {
  if (host) host.kill();
  app.quit();
});

app.on("before-quit", () => {
  if (host) host.kill();
});
