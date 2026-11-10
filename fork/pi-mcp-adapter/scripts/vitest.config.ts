import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts", "__tests__/**/*.test.ts", "test/runtime-mailbox-task.test.ts"],
    exclude: ["mcp-auth-*.test.ts", "secure-keyring.test.ts", "mailbox-task.test.ts"],
    setupFiles: ["./scripts/test-setup.ts"],
    pool: "threads",
    maxWorkers: 1,
    clearMocks: false,
  },
});
