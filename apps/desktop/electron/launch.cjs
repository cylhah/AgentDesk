const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

/**
 * Launcher for the Electron shell.
 *
 * Why a wrapper instead of calling `electron` directly: when AgentDesk itself is
 * started from inside an Electron app (for example a desktop IDE or this agent
 * harness), `ELECTRON_RUN_AS_NODE=1` is inherited by every child process. With
 * that flag the "electron" binary silently behaves like plain Node:
 * `require("electron")` returns a path string and `app` is undefined.
 *
 * So: resolve the real binary, drop the flag, and hand the app over.
 */
const electronPath = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [resolve(__dirname, "main.cjs"), ...process.argv.slice(2)];
console.log(`launching ${electronPath}`);

const child = spawn(electronPath, args, { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
