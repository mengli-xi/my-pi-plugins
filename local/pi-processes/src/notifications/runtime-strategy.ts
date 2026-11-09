import { getProcessWaitBridgeV2, type ProcessWaitBridgeV2 } from "pi-runtime-contracts/process-wait-bridge-v2";

import type { NotificationTargetV1 } from "./types.js";

export interface NotificationRuntimeStrategyV1 {
  captureTarget(): NotificationTargetV1;
}

export function createMainNotificationStrategyV1(sessionScopeId: string): NotificationRuntimeStrategyV1 {
  const target = Object.freeze({ strategy: "main" as const, scopeToken: sessionScopeId });
  return Object.freeze({ captureTarget: () => target });
}

/**
 * Subagent-specific owner capture. The managed child bridge is the authority
 * for the active Task/runtime token. A missing or stale bridge fails closed so
 * a process can never drift to the resident child's later Task.
 */
export function createChildNotificationStrategyV1(sessionScopeId: string, getBridge: (sessionScopeId: string) => ProcessWaitBridgeV2 | undefined = getProcessWaitBridgeV2): NotificationRuntimeStrategyV1 {
  return Object.freeze({
    captureTarget(): NotificationTargetV1 {
      const bridge = getBridge(sessionScopeId);
      if (!bridge) throw new Error("[process/owner-unavailable] Subagent Process owner bridge is unavailable");
      const scopeToken = bridge.captureOwnerToken();
      if (typeof scopeToken !== "string" || scopeToken.length === 0 || Buffer.byteLength(scopeToken, "utf8") > 512 || scopeToken.includes("\0")) {
        throw new Error("[process/owner-unavailable] Subagent Process owner token is invalid");
      }
      return Object.freeze({ strategy: "child", scopeToken });
    },
  });
}
