import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolveFromRoot = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agentdesk/protocol": resolveFromRoot("./packages/protocol/src/index.ts"),
      "@agentdesk/runtime": resolveFromRoot("./packages/runtime/src/index.ts"),
      "@agentdesk/tools": resolveFromRoot("./packages/tools/src/index.ts"),
      "@agentdesk/eval": resolveFromRoot("./packages/eval/src/index.ts"),
      "@agentdesk/store": resolveFromRoot("./packages/store/src/index.ts"),
      "@agentdesk/workspace": resolveFromRoot("./packages/workspace/src/index.ts"),
      "@agentdesk/bridge": resolveFromRoot("./packages/bridge/src/index.ts"),
      "@agentdesk/eventstream": resolveFromRoot("./packages/eventstream/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // One fork, one file at a time. On Windows, parallel workers race on Vite's
    // temp SSR cache (EBUSY) and on git worktree locks; the symptom is an
    // "unhandled error" plus a silently reduced test count, which is worse than
    // a slower suite. 100 tests still finish in ~3s.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
