import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getContinuationRegistryV1 } from "pi-runtime-contracts/continuation-v1";
import type { ProcessWaitBridgeV2 } from "pi-runtime-contracts/process-wait-bridge-v2";
import { ChildProcessWaitAdmissionV2, type ProcessWaitAdmissionRequestV2, type HostProcessWaitAdmissionV2 } from "./process-wait-admission.js";
import { admitOwnedProcessContinuationV2 } from "./process-wait-owner.js";

export interface ChildLifecyclePort {
  ready(): boolean;
  identity(): { ownerKey: string; agentId: string; generation: number; sessionId: string };
  frozenModel(): { provider: string; modelId: string; reasoningEffort: string; serviceTier?: string };
  taskId(): string;
  processWaitOwnerIds(): readonly string[];
  processAdmission(input: ProcessWaitAdmissionRequestV2): Promise<HostProcessWaitAdmissionV2>;
  recordProcessWait(input: { taskId: string; blocking: readonly { leaseId: string; generation: number; logicalKey: string }[] }): Promise<void>;
  settled(input: { taskId: string; aborted: boolean; sessionFile: string }): Promise<void>;
  report(error: unknown): void;
  shutdown(ctx: ExtensionContext): void;
}

const admissionCancellation = new WeakMap<ProcessWaitBridgeV2, (taskId: string, generation: number) => void>();
/** Internal SDK cancellation; the public Process bridge remains unchanged. */
export function cancelChildProcessAdmission(bridge: ProcessWaitBridgeV2 | undefined, taskId: string, generation: number): void {
  if (bridge) admissionCancellation.get(bridge)?.(taskId, generation);
}

/** SDK child lifecycle with durable Host admission and native settlement. */
export function installChildLifecycle(pi: ExtensionAPI, port: ChildLifecyclePort) {
  let admission: ChildProcessWaitAdmissionV2 | undefined, bridge: ProcessWaitBridgeV2 | undefined;
  pi.on("session_start", (_event, ctx) => {
    admission?.dispose();
    admission = new ChildProcessWaitAdmissionV2({ currentTaskId: port.taskId, childIdle: () => ctx.isIdle(),
      request: input => port.ready() ? port.processAdmission(input) : Promise.resolve("record-only"), report: port.report });
    const captureOwnerToken = () => {
      const taskId = port.taskId();
      if (!port.ready() || !taskId) throw new Error("Process owner token requires an active child Task");
      const { ownerKey, agentId, generation } = port.identity();
      return `process-owner-v1:${createHash("sha256").update([ownerKey, agentId, taskId, String(generation)].join("\0")).digest("hex")}`;
    };
    bridge = { version: 2, sessionId: ctx.sessionManager.getSessionId(), captureOwnerToken,
      admitContinuation: ({ admissionId, ownerToken, continuationSignal }) => admitOwnedProcessContinuationV2({ ownerToken, captureCurrentOwnerToken: captureOwnerToken,
        admit: () => admission?.admit(admissionId, continuationSignal) ?? Promise.resolve("record-only") }) };
    const currentBridge = bridge, currentAdmission = admission;
    admissionCancellation.set(bridge, (taskId, generation) => {
      if (bridge === currentBridge && port.identity().generation === generation && (!port.taskId() || port.taskId() === taskId)) currentAdmission.cancel(taskId);
    });
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (!port.ready()) return;
    const taskId = port.taskId(); if (!taskId) return;
    try {
      const blocking = getContinuationRegistryV1().snapshot(port.identity().sessionId).blocking.filter(item => port.processWaitOwnerIds().includes(item.ownerId))
        .map(({ leaseId, generation, logicalKey }) => ({ leaseId, generation, logicalKey }));
      if (blocking.length) await port.recordProcessWait({ taskId, blocking });
      if (port.taskId() !== taskId) return;
      if (!event.aborted && await admission?.beforeTaskSettlement(taskId)) return;
      if (port.taskId() === taskId) await port.settled({ taskId, aborted: event.aborted, sessionFile: ctx.sessionManager.getSessionFile() ?? "" });
    } catch (error) { port.report(error); port.shutdown(ctx); }
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!port.ready()) return;
    const frozen = port.frozenModel();
    if (ctx.model?.provider !== frozen.provider || ctx.model?.id !== frozen.modelId || ctx.thinkingLevel !== frozen.reasoningEffort) throw new Error("Subagent execution profile drifted from its frozen model or thinking level");
    if (frozen.provider !== "openai-codex" || frozen.serviceTier !== "priority") return;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) || Object.getPrototypeOf(event.payload) !== Object.prototype) throw new Error("openai-codex provider payload is not a plain object");
    return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
  });
  pi.on("session_shutdown", () => { admission?.dispose(); admission = undefined; bridge = undefined; });
  return { getBridge: (sessionId: string) => bridge?.sessionId === sessionId ? bridge : undefined };
}
