/**
 * On-disk store under `getAgentDir()/scheduler/`. The daemon is the ONLY
 * writer (decision #15); the extension/tool never write these files directly,
 * they send requests over IPC and the daemon applies them here.
 *
 * Layout:
 *   scheduler/
 *     tasks/<taskId>.json        one task definition per file
 *     runs/<taskId>.jsonl        append-style run records, pruned in place
 *
 * Writes are atomic (temp + rename) so a crash never leaves a half-written
 * task. Reads tolerate a missing directory (nothing scheduled yet).
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  applyRetention,
  DEFAULT_RETENTION,
  type RetentionPolicy,
  type RunRecord,
  type Task,
} from "./task.ts";
import type { RecordedNotice, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import type { OccupancyEntry } from "./occupancy.ts";

/** A task dispatched but not yet recorded; used for crash reconciliation. */
export interface InflightMarker {
  taskId: string;
  scheduledTime: number;
  startedAt: number;
  target: "agent" | "session";
  /** Daemon pid that owns this run, so a stale marker from a dead daemon is
   * distinguishable from a live one. */
  daemonPid: number;
}

/**
 * Durable occurrence state while a session-target task is owned by a live Pi.
 * Marker creation precedes watermark advance; startup repair advances any task
 * whose marker survived that small crash window. `append-uncertain` never
 * resends: the live binding only proves whether its injection id already exists.
 */
export interface InjectionMarker {
  injectionId: string;
  taskId: string;
  scheduledTime: number;
  prompt: string;
  title: string;
  sessionId: string;
  staleAt: number;
  phase: "pending" | "leased" | "append-uncertain" | "mailbox-owned" | "settled";
  /** Frozen live recipient at creation. Missing/mismatched identity is recovery,
   * never inferred from a new holder or wall-clock timestamps at offer time. */
  createdForHolder?: { pid: number; holderToken: string; bindingGen: number };
  mailbox?: { failureReason?: "run-aborted" | "run-error"; legacy?: boolean; anchorEntryId: string | null; recordedToken?: string; entryId?: string; startedAt?: number };
  leaseToken?: string;
  leaseExpiresAt?: number;
  holderPid?: number;
  holderToken?: string;
  /** Terminal outcome persisted before its run record/marker cleanup window. */
  terminalOutcome?: "delivered" | "failure";
  terminalDetail?: string;
  createdAt: number;
}

export interface InjectionTerminalReceipt {
  version: 1;
  marker: InjectionMarker;
  evidence: TerminalEvidence;
  finishedAt: number;
  runRecorded?: boolean;
}

/** Legacy imports have no frozen marker. Retain recorded/terminal proofs;
 * never invent prompt, title, staleAt or a new job. */
export interface LegacyInjectionTerminalReceipt {
  version: 1;
  legacy: true;
  evidence?: Extract<TerminalEvidence, { outcome: "fulfilled" }>;
  recorded?: RecordedNotice;
  recordedToken?: string;
}

export function legacyInjectionIdentity(receipt: LegacyInjectionTerminalReceipt) {
  return receipt.evidence ?? receipt.recorded!;
}

export class SchedulerStore {
  readonly root: string;
  private readonly tasksDir: string;
  private readonly runsDir: string;
  private readonly occupancyFile: string;
  private readonly inflightDir: string;
  private readonly injectionDir: string;
  private readonly receiptDir: string;
  private readonly retention: RetentionPolicy;

  constructor(root: string, retention: RetentionPolicy = DEFAULT_RETENTION) {
    this.root = root;
    this.tasksDir = join(root, "tasks");
    this.runsDir = join(root, "runs");
    this.occupancyFile = join(root, "occupancy.json");
    this.inflightDir = join(root, "inflight");
    this.injectionDir = join(root, "injection");
    this.receiptDir = join(root, "mailbox-receipts");
    this.retention = retention;
  }

  /** Create the store directories with private permissions. */
  init(): void {
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.inflightDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.injectionDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.receiptDir, { recursive: true, mode: 0o700 });
  }

  private taskPath(id: string): string {
    return join(this.tasksDir, `${encodeId(id)}.json`);
  }

  private runsPath(id: string): string {
    return join(this.runsDir, `${encodeId(id)}.jsonl`);
  }

  private inflightPath(id: string): string {
    return join(this.inflightDir, `${encodeId(id)}.json`);
  }

  private injectionPath(injectionId: string): string {
    return join(this.injectionDir, `${encodeId(injectionId)}.json`);
  }

  getInjectionReceipt(injectionId: string): InjectionTerminalReceipt | undefined {
    try {
      const receipt = JSON.parse(readFileSync(join(this.receiptDir, `${encodeId(injectionId)}.json`), "utf8"));
      if (!isInjectionReceipt(receipt) || receipt.marker.injectionId !== injectionId) {
        throw new Error("invalid scheduler mailbox receipt");
      }
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  listInjectionReceipts(): InjectionTerminalReceipt[] {
    if (!existsSync(this.receiptDir)) return [];
    return readdirSync(this.receiptDir).filter((name) => name.endsWith(".json") && !name.endsWith(".legacy.json")).map((name) => {
      const receipt = JSON.parse(readFileSync(join(this.receiptDir, name), "utf8"));
      if (!isInjectionReceipt(receipt) || name !== `${encodeId(receipt.marker.injectionId)}.json`) {
        throw new Error(`invalid scheduler mailbox receipt: ${name}`);
      }
      return receipt;
    });
  }

  putInjectionReceipt(receipt: InjectionTerminalReceipt): void {
    if (!isInjectionReceipt(receipt)) throw new Error("invalid scheduler mailbox receipt");
    this.init();
    atomicWrite(join(this.receiptDir, `${encodeId(receipt.marker.injectionId)}.json`), `${JSON.stringify(receipt)}\n`);
  }

  getLegacyInjectionReceipt(injectionId: string): LegacyInjectionTerminalReceipt | undefined {
    try {
      const receipt = JSON.parse(readFileSync(join(this.receiptDir, `${encodeId(injectionId)}.legacy.json`), "utf8"));
      if (!isLegacyInjectionReceipt(receipt) || legacyInjectionIdentity(receipt).key !== `injection:${injectionId}`) {
        throw new Error("invalid scheduler legacy mailbox receipt");
      }
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  listLegacyInjectionReceipts(): LegacyInjectionTerminalReceipt[] {
    if (!existsSync(this.receiptDir)) return [];
    return readdirSync(this.receiptDir).filter((name) => name.endsWith(".legacy.json")).map((name) => {
      const receipt = JSON.parse(readFileSync(join(this.receiptDir, name), "utf8"));
      if (!isLegacyInjectionReceipt(receipt) || name !== `${encodeId(legacyInjectionIdentity(receipt).key.slice(10))}.legacy.json`) {
        throw new Error(`invalid scheduler legacy mailbox receipt: ${name}`);
      }
      return receipt;
    });
  }

  putLegacyInjectionReceipt(receipt: LegacyInjectionTerminalReceipt): void {
    if (!isLegacyInjectionReceipt(receipt)) throw new Error("invalid scheduler legacy mailbox receipt");
    this.init();
    atomicWrite(join(this.receiptDir, `${encodeId(legacyInjectionIdentity(receipt).key.slice(10))}.legacy.json`), `${JSON.stringify(receipt)}\n`);
  }

  /** Persisted session occupancy, so a daemon restart keeps deferring held
   * sessions (decision #13) instead of treating them as free. */
  readOccupancy(): OccupancyEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(this.occupancyFile, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e): e is OccupancyEntry =>
        typeof e?.sessionId === "string" && typeof e?.pid === "number");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  writeOccupancy(entries: readonly OccupancyEntry[]): void {
    this.init();
    atomicWrite(this.occupancyFile, `${JSON.stringify(entries)}\n`);
  }

  /** Mark a task as dispatched-but-unfinished, so a daemon crash mid-run is
   * detectable on restart (a lost execution must leave a trace). */
  markInflight(marker: InflightMarker): void {
    this.init();
    atomicWrite(this.inflightPath(marker.taskId), `${JSON.stringify(marker)}\n`);
  }

  clearInflight(taskId: string): void {
    rmSync(this.inflightPath(taskId), { force: true });
  }

  putInjection(marker: InjectionMarker): void {
    if (!isInjectionMarker(marker)) throw new Error("invalid scheduler injection marker");
    this.init();
    atomicWrite(this.injectionPath(marker.injectionId), `${JSON.stringify(marker)}\n`);
  }

  getInjection(injectionId: string): InjectionMarker | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.injectionPath(injectionId), "utf8"));
      if (!isInjectionMarker(parsed)) throw new Error("invalid scheduler injection marker");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  listInjections(): InjectionMarker[] {
    let names: string[];
    try {
      names = readdirSync(this.injectionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const markers: InjectionMarker[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const parsed = JSON.parse(readFileSync(join(this.injectionDir, name), "utf8"));
      if (!isInjectionMarker(parsed)) throw new Error(`invalid scheduler injection marker: ${name}`);
      markers.push(parsed);
    }
    return markers.sort((a, b) => a.scheduledTime - b.scheduledTime);
  }

  listInjectionsForTask(taskId: string): InjectionMarker[] {
    return this.listInjections().filter((marker) => marker.taskId === taskId);
  }

  clearInjection(injectionId: string): void {
    rmSync(this.injectionPath(injectionId), { force: true });
  }

  listInflight(): InflightMarker[] {
    let names: string[];
    try {
      names = readdirSync(this.inflightDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const markers: InflightMarker[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.inflightDir, name), "utf8"));
        if (typeof parsed?.taskId === "string" && typeof parsed?.scheduledTime === "number") {
          markers.push(parsed as InflightMarker);
        }
      } catch {
        // Skip a torn marker; reconciliation is best-effort.
      }
    }
    return markers;
  }

  listTasks(): Task[] {
    let names: string[];
    try {
      names = readdirSync(this.tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const tasks: Task[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.tasksDir, name), "utf8"));
        if (isTask(parsed)) tasks.push(parsed);
      } catch {
        // A corrupt task file must not take the whole store down; skip it.
      }
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  getTask(id: string): Task | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.taskPath(id), "utf8"));
      return isTask(parsed) ? parsed : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  putTask(task: Task): void {
    this.init();
    atomicWrite(this.taskPath(task.id), `${JSON.stringify(task, null, 2)}\n`);
  }

  deleteTask(id: string): void {
    rmSync(this.taskPath(id), { force: true });
    rmSync(this.runsPath(id), { force: true });
    for (const marker of this.listInjectionsForTask(id)) this.clearInjection(marker.injectionId);
  }

  listRuns(id: string): RunRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.runsPath(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: RunRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (isRunRecord(parsed)) records.push(parsed);
      } catch {
        // Skip a torn trailing line rather than losing the whole history.
      }
    }
    return records;
  }

  /** Append a run record and prune the task's history in place. */
  appendRun(record: RunRecord, now: number = Date.now()): void {
    this.init();
    const pruned = applyRetention(
      [...this.listRuns(record.taskId), record],
      this.retention,
      now,
    );
    // Persist newest-last so the file reads chronologically.
    const body = pruned
      .sort((a, b) => a.finishedAt - b.finishedAt)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    atomicWrite(this.runsPath(record.taskId), body ? `${body}\n` : "");
  }

  /** Every unacknowledged failure across all tasks, newest first. */
  unacknowledgedFailures(): RunRecord[] {
    const failures: RunRecord[] = [];
    for (const task of this.listTasks()) {
      for (const record of this.listRuns(task.id)) {
        if (record.outcome === "failure" && !record.acknowledged) {
          failures.push(record);
        }
      }
    }
    return failures.sort((a, b) => b.finishedAt - a.finishedAt);
  }

  /** Mark every failure at or before `through` acknowledged. */
  acknowledgeFailures(through: number): void {
    for (const task of this.listTasks()) {
      const records = this.listRuns(task.id);
      let changed = false;
      for (const record of records) {
        if (
          record.outcome === "failure" && !record.acknowledged &&
          record.finishedAt <= through
        ) {
          record.acknowledged = true;
          changed = true;
        }
      }
      if (!changed) continue;
      const body = records
        .sort((a, b) => a.finishedAt - b.finishedAt)
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      atomicWrite(this.runsPath(task.id), body ? `${body}\n` : "");
    }
  }
}

function encodeId(id: string): string {
  // Task ids are uuids, but never trust one straight into a path.
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function atomicWrite(path: string, body: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, body, { mode: 0o600 });
  const fd = openSync(temp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && typeof task.prompt === "string" &&
    typeof task.schedule === "object" && task.schedule !== null &&
    typeof task.timeZone === "string" && typeof task.target === "object";
}

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.taskId === "string" &&
    typeof record.scheduledTime === "number" &&
    typeof record.finishedAt === "number" &&
    typeof record.outcome === "string";
}

function isInjectionMarker(value: unknown): value is InjectionMarker {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Record<string, unknown>;
  return typeof marker.injectionId === "string" &&
    typeof marker.taskId === "string" &&
    typeof marker.scheduledTime === "number" && Number.isFinite(marker.scheduledTime) &&
    typeof marker.prompt === "string" &&
    typeof marker.title === "string" &&
    typeof marker.sessionId === "string" &&
    typeof marker.staleAt === "number" && Number.isFinite(marker.staleAt) &&
    (marker.phase === "pending" || marker.phase === "leased" || marker.phase === "append-uncertain" || marker.phase === "mailbox-owned" || marker.phase === "settled") &&
    typeof marker.createdAt === "number" && Number.isFinite(marker.createdAt) &&
    (marker.createdForHolder === undefined || isCreatedForHolder(marker.createdForHolder)) &&
    (marker.mailbox === undefined || isMailboxMarker(marker.mailbox)) &&
    (marker.phase !== "mailbox-owned" || (isMailboxMarker(marker.mailbox) &&
      typeof marker.mailbox.recordedToken === "string" && typeof marker.mailbox.entryId === "string"));
}

function isCreatedForHolder(value: unknown): value is NonNullable<InjectionMarker["createdForHolder"]> {
  if (!value || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  return typeof h.pid === "number" && Number.isInteger(h.pid) && h.pid > 1 &&
    typeof h.holderToken === "string" && h.holderToken.length > 0 &&
    typeof h.bindingGen === "number" && Number.isInteger(h.bindingGen) && h.bindingGen >= 0;
}

function isMailboxMarker(value: unknown): value is NonNullable<InjectionMarker["mailbox"]> {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (m.failureReason === undefined || m.failureReason === "run-aborted" || m.failureReason === "run-error") && (m.legacy === undefined || typeof m.legacy === "boolean") && (m.anchorEntryId === null || typeof m.anchorEntryId === "string") &&
    (m.startedAt === undefined || (typeof m.startedAt === "number" && Number.isFinite(m.startedAt))) &&
    (m.recordedToken === undefined || typeof m.recordedToken === "string") &&
    (m.entryId === undefined || typeof m.entryId === "string");
}

function isInjectionReceipt(value: unknown): value is InjectionTerminalReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as InjectionTerminalReceipt;
  if (r.version !== 1 || !isInjectionMarker(r.marker) || !r.marker.mailbox || !r.evidence ||
      !Number.isFinite(r.finishedAt) || (r.runRecorded !== undefined && typeof r.runRecorded !== "boolean")) return false;
  const e = r.evidence;
  if (e.producer !== "pi-scheduler" || e.key !== `injection:${r.marker.injectionId}` ||
      typeof e.terminalId !== "string" || !e.terminalId || e.scope?.sessionId !== r.marker.sessionId ||
      e.scope.anchorEntryId !== r.marker.mailbox.anchorEntryId) return false;
  return e.outcome === "cancelled" ? typeof e.reason === "string" && !!e.reason : e.outcome === "fulfilled" &&
    typeof e.assistantEntryId === "string" && !!e.assistantEntryId && typeof e.receiptEntryId === "string" && !!e.receiptEntryId &&
    Array.isArray(e.nativeEntryIds) && e.nativeEntryIds.length === 1 && e.nativeEntryIds[0] === r.marker.mailbox.entryId;
}

function isLegacyInjectionReceipt(value: unknown): value is LegacyInjectionTerminalReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as LegacyInjectionTerminalReceipt, identity = r.evidence ?? r.recorded;
  if (r.version !== 1 || r.legacy !== true || !identity || identity.producer !== "pi-scheduler" ||
      typeof identity.key !== "string" || !identity.key.startsWith("injection:") || identity.key.length <= 10 ||
      typeof identity.scope?.sessionId !== "string" || !identity.scope.sessionId ||
      !(identity.scope.anchorEntryId === null || typeof identity.scope.anchorEntryId === "string")) return false;
  const e = r.evidence, n = r.recorded;
  if (e && (typeof e.terminalId !== "string" || !e.terminalId || e.outcome !== "fulfilled" ||
      typeof e.assistantEntryId !== "string" || !e.assistantEntryId || typeof e.receiptEntryId !== "string" || !e.receiptEntryId ||
      !Array.isArray(e.nativeEntryIds) || e.nativeEntryIds.length !== 1 || typeof e.nativeEntryIds[0] !== "string" || !e.nativeEntryIds[0])) return false;
  if (n && (n.producer !== identity.producer || n.key !== identity.key || n.scope?.sessionId !== identity.scope.sessionId ||
      n.scope.anchorEntryId !== identity.scope.anchorEntryId || typeof n.recordedToken !== "string" || !n.recordedToken ||
      !Array.isArray(n.entries) || n.entries.length !== 1 || n.entries[0]?.messageIndex !== 0 ||
      typeof n.entries[0].entryId !== "string" || !n.entries[0].entryId || e && e.nativeEntryIds[0] !== n.entries[0].entryId)) return false;
  return r.recordedToken === undefined || typeof r.recordedToken === "string" && !!r.recordedToken && (!n || n.recordedToken === r.recordedToken);
}
