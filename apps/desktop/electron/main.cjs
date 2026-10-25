const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");

/**
 * Electron shell.
 *
 * It does not reimplement the host: it spawns the same Node host the CLI runs
 * (`apps/desktop/src/main.ts`, executed with the Electron binary in
 * ELECTRON_RUN_AS_NODE mode) and points a sandboxed window at it.
 *
 * What is actually "native" here:
 *   - the window lifecycle and the OS-level process boundary
 *   - a preload bridge exposing exactly two methods (`info`, `resolveApproval`)
 *   - a renderer with no Node access (contextIsolation + sandbox)
 *
 * Kept as CommonJS on purpose: Electron's main module is CJS, and mixing it
 * with an ESM entry means interop games that fail differently per version.
 */
const repo = resolve(__dirname, "../../..");
const tsxCli = resolve(repo, "node_modules/tsx/dist/cli.mjs");
const hostEntry = resolve(repo, "apps/desktop/src/main.ts");

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

function startHost(port, hostArgs) {
  return new Promise((resolveUrl, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, hostEntry, "--port", String(port), "--no-auth", ...hostArgs],
      {
        cwd: repo,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
  const hostArgs = process.argv.slice(2);
  const started = await startHost(port, hostArgs);
  host = started.child;
  hostUrl = started.url;

  let shellInfoCalls = 0;
  ipcMain.handle("shell:info", () => {
    shellInfoCalls += 1;
    if (shellInfoCalls === 1) {
      // Proof that the sandboxed renderer reached the native surface through
      // the preload bridge (this only fires on a real IPC round-trip).
      console.log("preload bridge alive: renderer called shell:info");
      try {
        require("node:fs").writeFileSync(
          resolve(repo, "runs/shell-bridge.log"),
          `preload bridge ok at ${new Date().toISOString()}\n`,
        );
      } catch {
        // diagnostics only
      }
    }
    return {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      host: hostUrl,
    };
  });

  // The renderer cannot call the host's HTTP API with a token it does not know
  // (host runs --no-auth here), so approval resolution goes through the main
  // process. This is the native surface: two methods, both explicit.
  ipcMain.handle("shell:resolve-approval", async (_event, decision) => {
    const response = await fetch(`${hostUrl}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "turn.resolve", params: { decision } }),
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
      preload: resolve(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window && window.show());
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
