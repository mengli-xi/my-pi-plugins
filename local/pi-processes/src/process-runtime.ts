import { join } from "node:path";
import { assertProcessesExecutionIsolationCurrent, processesExecutionAuthority, type ProcessesConfig } from "./config.js";
import { getOrCreateProcessHost } from "./host/registry.js";
import type { ProcessHost } from "./host/process-host.js";
import { SupervisorClient } from "./host/supervisor-client.js";
import type { NotificationRuntimeStrategyV1 } from "./notifications/runtime-strategy.js";
import { resolveHelperRuntime } from "./supervisor/runtime-resolver.js";

let supervisorGeneration = 0;

export function createProcessHost(sessionScopeId: string, config: () => ProcessesConfig, distDirectory: string, notificationStrategy?: NotificationRuntimeStrategyV1): ProcessHost {
  const snapshot = config();
  const executionAuthority = processesExecutionAuthority(snapshot);
  return getOrCreateProcessHost({
    sessionScopeId,
    executionAuthority,
    ...(notificationStrategy ? { captureNotificationTarget: () => notificationStrategy.captureTarget() } : {}),
    launch: async callbacks => {
      await assertProcessesExecutionIsolationCurrent(snapshot);
      const supervisorPath = join(distDirectory, "supervisor.js");
      const resolved = await resolveHelperRuntime({ helperRuntime: snapshot.execution.helperRuntime, supervisorPath, processExecPath: process.execPath });
      if (!resolved.runtime) {
        const attempts = resolved.attempts.map(attempt => `${attempt.path}: ${attempt.outcome}`).join("; ");
        throw new Error(`[process/helper-runtime-unavailable] no compatible Node/Bun runtime${attempts ? ` (${attempts})` : ""}`);
      }
      await assertProcessesExecutionIsolationCurrent(snapshot);
      const generation = ++supervisorGeneration;
      return SupervisorClient.launch({
        runtimePath: resolved.runtime.candidate.path, supervisorPath, sessionScopeId, generation,
        isolation: snapshot.execution.isolation, onEvent: callbacks.onEvent, onChannelLost: callbacks.onChannelLost,
      });
    },
  });
}
