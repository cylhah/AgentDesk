import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Portable build: `dist/AgentDesk/electron.exe` + `resources/app/` (bundled host,
 * view assets, preload). No installer, no code signing — this is the smallest
 * thing that runs on a machine without a toolchain.
 *
 * Why bundle: the host is TypeScript across a pnpm workspace. Shipping node_modules
 * would be ~300MB and still need tsx at runtime; esbuild turns it into one ~200KB
 * ESM file (node:sqlite stays external, it is built into Node 22+).
 */
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = join(repo, "dist", "AgentDesk");
const appDir = join(out, "resources", "app");
const electronDist = join(repo, "node_modules", "electron", "dist");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(electronDist))) {
  console.error("electron binary missing — run `node node_modules/electron/install.js` first");
  process.exit(1);
}

// Rebuilding must not delete a user's conversations. The portable layout keeps
// `runs/` and `.env` next to the executable, which is exactly where the build
// output lives — so stash them across the clean and put them back.
console.log("preserving runs/ and .env …");
const stash = join(repo, "dist", ".stash");
await rm(stash, { recursive: true, force: true });
await mkdir(stash, { recursive: true });
for (const name of ["runs", ".env"]) {
  const from = join(out, name);
  if (await exists(from)) await cp(from, join(stash, name), { recursive: true });
}

console.log("cleaning dist/AgentDesk …");
await rm(out, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

console.log("bundling host …");
await build({
  entryPoints: [join(repo, "apps", "desktop", "src", "main.ts")],
  outfile: join(appDir, "host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:sqlite"],
  logLevel: "warning",
});

console.log("copying view …");
await cp(join(repo, "apps", "desktop", "src", "view"), join(appDir, "view"), { recursive: true });

console.log("copying shell …");
await cp(join(repo, "apps", "desktop", "electron", "packaged-main.cjs"), join(appDir, "main.cjs"));
await cp(join(repo, "apps", "desktop", "electron", "preload.cjs"), join(appDir, "preload.cjs"));
await writeFile(
  join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "agentdesk",
      version: "0.1.0",
      private: true,
      type: "commonjs",
      main: "main.cjs",
    },
    null,
    2,
  ),
  "utf8",
);

console.log("copying electron runtime (~300MB, one time) …");
await cp(electronDist, out, { recursive: true });

// Electron must not inherit ELECTRON_RUN_AS_NODE: launched from another Electron
// app (IDE, agent harness), the flag turns this binary into plain Node and no
// window appears. `set VAR=` clears it for the child process.
await writeFile(
  join(out, "AgentDesk.cmd"),
  [
    "@echo off",
    "set ELECTRON_RUN_AS_NODE=",
    'start "" "%~dp0electron.exe"',
    "",
  ].join("\r\n"),
  "utf8",
);

await writeFile(
  join(out, "README.txt"),
  [
    "AgentDesk (portable build)",
    "",
    "1. 双击 AgentDesk.cmd 启动（不要直接双击 electron.exe —— 从其他 Electron",
    "   应用启动时会继承 ELECTRON_RUN_AS_NODE，窗口不会出现）。",
    "2. 首次使用：在本目录建一个 .env，内容示例：",
    "     OPENAI_API_KEY=sk-...",
    "     OPENAI_BASE_URL=https://api.deepseek.com/v1",
    "     OPENAI_MODEL=deepseek-chat",
    "3. 会话与事件存放在本目录的 runs/ 下（便携模式：拷走整个文件夹即带走数据）。",
    "",
    "这个构建没有安装包、没有代码签名、也不会自动更新。",
    "",
  ].join("\r\n"),
  "utf8",
);

// Put the user's data back exactly where the portable build expects it.
for (const name of ["runs", ".env"]) {
  const from = join(stash, name);
  if (await exists(from)) await cp(from, join(out, name), { recursive: true });
}
await rm(stash, { recursive: true, force: true });

const exe = join(out, "electron.exe");
if (await exists(exe)) {
  console.log(`\nportable build ready: ${join(out, "AgentDesk.cmd")}`);
} else {
  console.log(`\nbuild finished, but ${exe} was not found`);
}
