import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("package exports load under Node strip-only without a resolver hook", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      "import { getContinuationRegistryV1 } from 'pi-runtime-contracts/continuation-v1'; import { createChildCapabilityRegistryV1 } from 'pi-runtime-contracts/child-capabilities-v1'; import { getProcessWaitBridgeV1 } from 'pi-runtime-contracts/process-wait-bridge-v1'; import { getProcessWaitBridgeV2 } from 'pi-runtime-contracts/process-wait-bridge-v2'; import { queryGoalContinuationObligationV1 } from 'pi-runtime-contracts/goal-continuation-obligation-v1'; import { PROVIDER_ACTIVITY_CHANNEL, readProviderActivityV1 } from 'pi-runtime-contracts/provider-activity-v1'; if (PROVIDER_ACTIVITY_CHANNEL !== 'provider:activity-v1' || readProviderActivityV1({ version: 1, provider: 'test', sessionId: 'test', kind: 'turn.end' })?.version !== 1 || getContinuationRegistryV1().apiVersion !== 1 || createChildCapabilityRegistryV1().version !== 2 || getProcessWaitBridgeV1('absent') !== undefined || getProcessWaitBridgeV2('absent') !== undefined || queryGoalContinuationObligationV1({ sessionId: 'absent', continuationId: 'absent' }) !== 'none') process.exit(2);",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("retired Subagent-only export is absent", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      "import('pi-runtime-contracts/subagent-capabilities-v1')",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Package subpath '.\/subagent-capabilities-v1' is not defined/);
});
