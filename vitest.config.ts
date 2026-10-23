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
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
