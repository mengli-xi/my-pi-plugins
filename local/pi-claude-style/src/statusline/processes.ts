import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PROCESSES_OPEN_REQUEST_CHANNEL,
  PROCESSES_SNAPSHOT_REQUEST_CHANNEL,
  PROCESSES_STATUS_SNAPSHOT_CHANNEL,
  STATUS_LINE_PROCESSES_ROW_KEY,
  STATUS_LINE_ROW_CHANNEL,
} from "../integration-contracts.ts";

type ProcessKind = "process" | "monitor" | "service";

interface ProcessSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: ProcessKind;
  readonly state: "starting" | "running" | "stopping";
}

interface ProcessesStatusSnapshotV2 {
  readonly version: 2;
  readonly sessionScopeId: string;
  readonly revision: number;
  readonly emittedAt: string;
  readonly processes: readonly ProcessSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is ProcessesStatusSnapshotV2 {
  if (!isRecord(value) || value.version !== 2) return false;
  if (typeof value.sessionScopeId !== "string" || value.sessionScopeId.length === 0) return false;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false;
  if (typeof value.emittedAt !== "string" || !Array.isArray(value.processes)) return false;
  return value.processes.every((process) =>
    isRecord(process) &&
    typeof process.id === "string" &&
    typeof process.name === "string" &&
    (process.kind === "process" || process.kind === "monitor" || process.kind === "service") &&
    (process.state === "starting" || process.state === "running" || process.state === "stopping")
  );
}

function sessionId(ctx: ExtensionContext): string | undefined {
  const value = ctx.sessionManager.getSessionId();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface InstalledProcessesStatusConsumer {
  dispose(): void;
}

export function installProcessesStatusConsumer(pi: ExtensionAPI): InstalledProcessesStatusConsumer {
  let activeCtx: ExtensionContext | undefined;
  let activeSession: string | undefined;
  let acceptedRevision = -1;
  let snapshot: ProcessesStatusSnapshotV2 | undefined;

  const withdraw = (): void => {
    snapshot = undefined;
    acceptedRevision = -1;
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, { key: STATUS_LINE_PROCESSES_ROW_KEY });
  };

  const publish = (): void => {
    const current = snapshot;
    const ctx = activeCtx;
    if (!current || !ctx || current.processes.length === 0) {
      pi.events.emit(STATUS_LINE_ROW_CHANNEL, { key: STATUS_LINE_PROCESSES_ROW_KEY });
      return;
    }
    const counts = new Map<ProcessKind, number>();
    for (const process of current.processes) counts.set(process.kind, (counts.get(process.kind) ?? 0) + 1);
    const tones = {
      process: "customMessageLabel",
      monitor: "accent",
      service: "success",
    } as const;
    const separator = ctx.ui.theme.fg("muted", " · ");
    const line = (["process", "monitor", "service"] as const)
      .filter((kind) => counts.has(kind))
      .map((kind) => ctx.ui.theme.fg(tones[kind], `${kind} ${counts.get(kind)}`))
      .join(separator);
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, {
      key: STATUS_LINE_PROCESSES_ROW_KEY,
      placement: "inline",
      row: 3,
      align: "left",
      line,
      onClick: () => {
        const latest = snapshot;
        if (!latest || latest.sessionScopeId !== activeSession) return false;
        pi.events.emit(PROCESSES_OPEN_REQUEST_CHANNEL, {
          version: 2,
          requestId: randomUUID(),
          sessionScopeId: latest.sessionScopeId,
          observedRevision: latest.revision,
          source: "statusline",
        });
        return true;
      },
    });
  };

  const stopSnapshot = pi.events.on(PROCESSES_STATUS_SNAPSHOT_CHANNEL, (value: unknown) => {
    if (!isSnapshot(value) || value.sessionScopeId !== activeSession) return;
    if (value.revision <= acceptedRevision) return;
    acceptedRevision = value.revision;
    snapshot = value;
    publish();
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    activeSession = sessionId(ctx);
    snapshot = undefined;
    acceptedRevision = -1;
    withdraw();
    if (!activeSession) return;
    pi.events.emit(PROCESSES_SNAPSHOT_REQUEST_CHANNEL, {
      version: 2,
      requestId: randomUUID(),
      sessionScopeId: activeSession,
      source: "statusline",
    });
  });

  pi.on("session_shutdown", () => {
    activeCtx = undefined;
    activeSession = undefined;
    withdraw();
  });

  return {
    dispose() {
      stopSnapshot();
      activeCtx = undefined;
      activeSession = undefined;
      withdraw();
    },
  };
}
