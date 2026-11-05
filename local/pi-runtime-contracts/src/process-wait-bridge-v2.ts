export type ProcessWaitAdmissionV2 = "trigger" | "record-only";

export interface ProcessWaitBridgeV2 {
  readonly version: 2;
  readonly sessionId: string;
  /**
   * Subagent-specific owner capture. The token binds a process to the Task and
   * runtime generation active when process start commits. Callers treat it as
   * opaque and fail closed when capture is unavailable.
   */
  captureOwnerToken(): string;
  admitContinuation(input: {
    /** Stable batch identity. Replays must return the original admission. */
    readonly admissionId: string;
    /** Opaque Task/runtime identity captured when the process start committed. */
    readonly ownerToken: string;
    readonly continuationSignal: boolean;
  }): Promise<ProcessWaitAdmissionV2>;
}

const CELL = Symbol.for("pi.subagents.process-wait-bridge.v2");

interface Cell {
  readonly bySession: Map<string, ProcessWaitBridgeV2>;
}

function cell(): Cell {
  const root = globalThis as typeof globalThis & { [CELL]?: Cell };
  const descriptor = Object.getOwnPropertyDescriptor(root, CELL);
  if (descriptor) {
    const holder: unknown = descriptor.value;
    const sessions = holder && typeof holder === "object" && !Array.isArray(holder)
      ? Object.getOwnPropertyDescriptor(holder, "bySession") : undefined;
    if (!sessions || !("value" in sessions) || !(sessions.value instanceof Map)) {
      throw new Error("incompatible Process wait bridge v2 holder");
    }
    return holder as Cell;
  }
  return root[CELL] = Object.freeze({ bySession: new Map() }) as Cell;
}

export function registerProcessWaitBridgeV2(bridge: ProcessWaitBridgeV2): { dispose(): void } {
  if (!bridge || bridge.version !== 2 || typeof bridge.sessionId !== "string" || !bridge.sessionId
    || typeof bridge.captureOwnerToken !== "function" || typeof bridge.admitContinuation !== "function") {
    throw new Error("invalid Process wait bridge");
  }
  const current = cell();
  if (current.bySession.has(bridge.sessionId)) throw new Error("Process wait bridge already registered");
  current.bySession.set(bridge.sessionId, bridge);
  let active = true;
  return Object.freeze({
    dispose() {
      if (!active) return;
      active = false;
      if (current.bySession.get(bridge.sessionId) === bridge) current.bySession.delete(bridge.sessionId);
    },
  });
}

export function getProcessWaitBridgeV2(sessionId: string): ProcessWaitBridgeV2 | undefined {
  return cell().bySession.get(sessionId);
}
