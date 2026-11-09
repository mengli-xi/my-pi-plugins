import { defaultProcessesConfig } from "../src/config.ts";
import type { ExecutionIsolationV1 } from "../src/execution-isolation.ts";

export const isolationFixture: ExecutionIsolationV1 = Object.freeze({
  version: 1, owner: "test-owner", revision: 1, removeEnv: Object.freeze(["TEST_BROKER_ID", "TEST_REPLY_FD"]),
});

export function isolatedProcessesConfig() {
  const config = defaultProcessesConfig();
  return { ...config, execution: { ...config.execution, isolation: isolationFixture } };
}
