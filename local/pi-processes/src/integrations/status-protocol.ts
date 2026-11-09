import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ProcessHost } from "../host/process-host.js";

export const PROCESSES_STATUS_SNAPSHOT_CHANNEL = "statusline:processes-snapshot-v2";
export const PROCESSES_SNAPSHOT_REQUEST_CHANNEL = "processes:snapshot-request-v2";
export const PROCESSES_OPEN_REQUEST_CHANNEL = "processes:open-request-v2";
export const PROCESSES_MANAGED_SNAPSHOT_CHANNEL = "processes:managed-snapshot-v1";
export const PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL = "processes:managed-snapshot-request-v1";

/** PID/PGID/parent are candidates only; consumers must verify kernel birth and ownership. */
export interface ManagedProcessGroupV1 {
  readonly key: string;
  readonly kind: "supervisor" | "command";
  readonly pid: number;
  readonly pgid: number;
  readonly parent_pid: number;
}

export interface ProcessesManagedSnapshotV1 {
  readonly version: 1;
  readonly scope_id: string;
  readonly host_generation: string;
  readonly revision: number;
  readonly starting_count: number;
  readonly running_count: number;
  readonly stopping_count: number;
  readonly processes: readonly {
    readonly id: string;
    readonly state: "starting" | "running" | "stopping";
    readonly timeoutMs: number | null;
    readonly deadlineAt: string | null;
    readonly group_key: string | null;
  }[];
  readonly supervisor_key: string | null;
  readonly groups: readonly ManagedProcessGroupV1[];
  readonly release_groups: readonly string[];
  readonly wakePending: boolean;
  readonly cleanup: "open" | "closing" | "closed" | "unknown";
}

interface StatusRuntime {
  readonly sessionScopeId: string;
  readonly host: ProcessHost;
  readonly hasUI: boolean;
  readonly managed?: boolean;
  open(processId?: string): void;
  report(message: string): void;
}

export interface ProcessesStatusSnapshotV2 {
  readonly version: 2;
  readonly sessionScopeId: string;
  readonly revision: number;
  readonly emittedAt: string;
  readonly processes: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: "process" | "monitor" | "service";
    readonly state: "starting" | "running" | "stopping";
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RecentRequestIds {
  readonly #ids = new Set<string>();
  readonly #order: string[] = [];

  add(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    this.#order.push(id);
    while (this.#order.length > 128) {
      const removed = this.#order.shift();
      if (removed) this.#ids.delete(removed);
    }
    return true;
  }

  clear(): void {
    this.#ids.clear();
    this.#order.length = 0;
  }
}

export interface InstalledProcessesStatusProtocol {
  attach(runtime: StatusRuntime): void;
  detach(): void;
  publish(): ProcessesStatusSnapshotV2 | undefined;
}

export function installProcessesStatusProtocol(
  pi: Pick<ExtensionAPI, "events">,
  getRuntime: () => StatusRuntime | undefined,
): InstalledProcessesStatusProtocol {
  let attachedSession: string | undefined;
  const snapshotRequests = new RecentRequestIds();
  const openRequests = new RecentRequestIds();
  const managedRequests = new RecentRequestIds();
  let unsubscribeManaged: (() => void) | undefined;

  const publishManaged = (): void => {
    const runtime = getRuntime();
    if (!runtime?.managed || runtime.sessionScopeId !== attachedSession) return;
    pi.events.emit(PROCESSES_MANAGED_SNAPSHOT_CHANNEL, runtime.host.managedSnapshot());
  };

  const build = (): ProcessesStatusSnapshotV2 | undefined => {
    const runtime = getRuntime();
    if (!runtime || runtime.sessionScopeId !== attachedSession) return undefined;
    const processes = runtime.host.records()
      .filter((process): process is typeof process & { state: "starting" | "running" | "stopping" } =>
        process.state === "starting" || process.state === "running" || process.state === "stopping")
      .map(({ id, name, kind, state }) => ({ id, name, kind, state }));
    return {
      version: 2,
      sessionScopeId: runtime.sessionScopeId,
      revision: runtime.host.hostRevision,
      emittedAt: new Date().toISOString(),
      processes,
    };
  };

  const publish = (): ProcessesStatusSnapshotV2 | undefined => {
    const snapshot = build();
    if (snapshot) pi.events.emit(PROCESSES_STATUS_SNAPSHOT_CHANNEL, snapshot);
    publishManaged();
    return snapshot;
  };

  pi.events.on(PROCESSES_SNAPSHOT_REQUEST_CHANNEL, (value: unknown) => {
    if (!isRecord(value) || value.version !== 2 || value.source !== "statusline") return;
    if (typeof value.requestId !== "string" || typeof value.sessionScopeId !== "string") return;
    const runtime = getRuntime();
    if (!runtime || value.sessionScopeId !== runtime.sessionScopeId) return;
    if (!snapshotRequests.add(value.requestId)) return;
    publish();
  });

  pi.events.on(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, (value: unknown) => {
    // This read-only bus is not an authorization boundary. Caller labels do not
    // grant ownership; only the attached managed scope can supply a snapshot.
    if (!isRecord(value) || value.version !== 1) return;
    if (typeof value.requestId !== "string" || value.requestId.length === 0 || value.requestId.length > 256
      || typeof value.scope_id !== "string" || value.scope_id.length === 0 || value.scope_id.length > 256) return;
    const runtime = getRuntime();
    if (!runtime?.managed || value.scope_id !== runtime.sessionScopeId || runtime.sessionScopeId !== attachedSession) return;
    if (!managedRequests.add(value.requestId)) return;
    publishManaged();
  });

  pi.events.on(PROCESSES_OPEN_REQUEST_CHANNEL, (value: unknown) => {
    if (!isRecord(value) || value.version !== 2 || value.source !== "statusline") return;
    if (typeof value.requestId !== "string" || typeof value.sessionScopeId !== "string") return;
    if (!Number.isSafeInteger(value.observedRevision) || (value.observedRevision as number) < 0) return;
    const runtime = getRuntime();
    if (!runtime || value.sessionScopeId !== runtime.sessionScopeId) return;
    if (!openRequests.add(value.requestId)) return;
    if ((value.observedRevision as number) > runtime.host.hostRevision) {
      runtime.report(`Ignored future process open request ${value.requestId}`);
      return;
    }
    if (!runtime.hasUI) {
      runtime.report("Ignored process open request without an active TUI");
      return;
    }
    const targetId = typeof value.targetId === "string" && runtime.host.summary(value.targetId)
      ? value.targetId
      : undefined;
    runtime.open(targetId);
  });

  return {
    attach(runtime) {
      unsubscribeManaged?.();
      attachedSession = runtime.sessionScopeId;
      snapshotRequests.clear();
      openRequests.clear();
      managedRequests.clear();
      unsubscribeManaged = runtime.managed ? runtime.host.subscribeManagedState(publishManaged) : undefined;
      publish();
    },
    detach() {
      unsubscribeManaged?.();
      unsubscribeManaged = undefined;
      attachedSession = undefined;
      snapshotRequests.clear();
      openRequests.clear();
      managedRequests.clear();
    },
    publish,
  };
}

export function createProcessesSnapshotRequest(sessionScopeId: string): Record<string, unknown> {
  return { version: 2, requestId: randomUUID(), sessionScopeId, source: "statusline" };
}
