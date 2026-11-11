/**
 * Daemon core: the tick loop that ties the store, planner, occupancy registry
 * and executor together. It is the single writer of task state and run records
 * (decision #15). Time, the runner, and the failure-notifier are injected so
 * the whole loop is testable without real clocks, spawns, or notifications.
 *
 * Session-target occurrences held by a live Pi use a durable injection marker.
 * The marker is written before the task watermark advances, so startup repair
 * can recover either side of that write pair. A leased append is never retried
 * after its outcome becomes uncertain; the next poll receives proof-only work.
 */

import { createHash, randomUUID } from "node:crypto";
import { SchedulerMailboxDaemon } from "./mailbox-daemon.ts";
import { OVER_LIMIT_RECHECK_MS, planTick } from "./planner.ts";
import type { OccupancyRegistry } from "./occupancy.ts";
import type { InjectionMarker, SchedulerStore } from "./store.ts";
import type { RunRecord, Task } from "./task.ts";
import type { ExecutionResult, TaskRunner } from "./executor.ts";

export interface DaemonOptions {
  store: SchedulerStore;
  occupancy: OccupancyRegistry;
  runner: TaskRunner;
  piBinary: string;
  concurrency: number;
  now: () => number;
  /** Called once per failed run so the host can surface a system notification. */
  onFailure?: (task: Task, record: RunRecord) => void;
}

export interface InjectionPollInput {
  sessionId: string;
  pid: number;
  holderToken: string;
  bindingGen: number;
}

interface InjectionOfferBase {
  injectionId: string;
  taskId: string;
  title: string;
  prompt: string;
  contentDigest: string;
  scheduledTime: number;
}

export type DaemonInjectionOffer =
  | (InjectionOfferBase & { mode: "append"; leaseToken: string; expiresAt: number })
  | (InjectionOfferBase & { mode: "prove" });

export interface InjectionAckInput {
  injectionId: string;
  leaseToken?: string;
  entryId: string;
}

export type InjectionNackReason = "not-appended" | "append-unknown" | "content-conflict";

export interface InjectionNackInput {
  injectionId: string;
  leaseToken?: string;
  reason: InjectionNackReason;
}

export type InjectionMutationResult = { ok: true } | { ok: false; error: string };

/** Leases are deliberately short and are also capped by the task tolerance. */
export const INJECTION_LEASE_MS = 30_000;

/** Is a daemon pid still alive? Signal 0 probe, EPERM = alive but not ours. */
function defaultDaemonAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SchedulerDaemon {
  private readonly options: DaemonOptions;
  /** taskIds currently executing, so a slow run is not double-dispatched. */
  private readonly inFlight = new Set<string>();
  private draining = false;
  readonly mailbox: SchedulerMailboxDaemon;

  constructor(options: DaemonOptions) {
    this.options = options;
    this.mailbox = new SchedulerMailboxDaemon(options);
  }

  get runningCount(): number {
    return this.inFlight.size;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Stop accepting new execution work. A leased append may already have
   * reached the session before its ack, so preserve it as proof-only state.
   */
  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    for (const marker of this.options.store.listInjections()) {
      if (this.mailbox.reconcile(marker)) continue;
      if (marker.phase === "leased") this.toAppendUncertain(marker);
    }
  }

  hasActiveInjection(taskId: string): boolean {
    return this.options.store.listInjectionsForTask(taskId).length > 0;
  }

  /**
   * Run a task's frozen prompt immediately, out of band, without touching the
   * schedule watermark. A session held by a live Pi is refused so a manual run
   * never writes a session concurrently with that Pi.
   */
  runNow(task: Task): { started: boolean; reason?: string } {
    if (this.draining) return { started: false, reason: "daemon is draining" };
    if (this.inFlight.has(task.id)) return { started: false, reason: "already running" };
    if (this.hasActiveInjection(task.id)) {
      return { started: false, reason: "task has active injection occurrence" };
    }
    if (
      task.target.kind === "session" &&
      this.options.occupancy.isOccupied(task.target.sessionId)
    ) {
      return { started: false, reason: "session is open in a live Pi" };
    }
    void this.execute(task, this.options.now(), { advance: false });
    return { started: true };
  }

  /**
   * Run one planning pass. Existing markers are reconciled before normal
   * schedule evaluation. A pending marker whose session became free is handed
   * directly to the subprocess path without evaluating or advancing it again.
   */
  tick(): { wakeAt?: number; dispatched: string[] } {
    if (this.draining) return { dispatched: [] };
    const { store, occupancy, concurrency, now } = this.options;
    const at = now();
    const dispatched: string[] = [];
    let markerWakeAt: number | undefined;
    const noteMarkerWake = (instant: number) => {
      if (markerWakeAt === undefined || instant < markerWakeAt) markerWakeAt = instant;
    };

    for (const original of store.listInjections()) {
      if (this.mailbox.reconcile(original)) continue;
      if (original.mailbox) continue;
      // A legacy append/proof debt may already have native success evidence.
      // Preserve the frozen intent until the new source imports/proves it;
      // elapsed time cannot turn an unknown append into a terminal failure.
      if (original.phase === "append-uncertain" ||
          (original.phase === "settled" && original.terminalOutcome !== "failure")) continue;
      if (original.phase === "leased" && at > original.staleAt) {
        this.toAppendUncertain(original);
        continue;
      }
      let marker = original;
      const recorded = this.injectionRun(marker);
      if (recorded) {
        store.clearInjection(marker.injectionId);
        continue;
      }
      if (marker.phase === "settled") {
        this.finalizeSettled(marker);
        continue;
      }
      if (at > marker.staleAt) {
        this.settleInjection(marker, "failure", "injection-stale");
        continue;
      }
      if (marker.phase === "leased") {
        if (
          (marker.leaseExpiresAt !== undefined && at >= marker.leaseExpiresAt) ||
          !this.markerHolderIsCurrent(marker)
        ) {
          marker = this.toAppendUncertain(marker);
        } else {
          noteMarkerWake(Math.min(marker.leaseExpiresAt ?? marker.staleAt + 1, marker.staleAt + 1));
          continue;
        }
      }
      if (marker.phase === "append-uncertain") {
        noteMarkerWake(marker.staleAt + 1);
        continue;
      }
      if (marker.phase !== "pending") continue;

      noteMarkerWake(marker.staleAt + 1);
      if (occupancy.isOccupied(marker.sessionId)) continue;
      if (this.inFlight.has(marker.taskId) || this.inFlight.size >= concurrency) {
        noteMarkerWake(at + OVER_LIMIT_RECHECK_MS);
        continue;
      }
      const task = store.getTask(marker.taskId);
      if (!task || task.target.kind !== "session" || task.target.sessionId !== marker.sessionId) {
        this.settleInjection(marker, "failure", "injection-task-missing-or-changed");
        continue;
      }
      const snapshot: Task = { ...task, title: marker.title, prompt: marker.prompt };
      dispatched.push(task.id);
      void this.execute(snapshot, marker.scheduledTime, {
        advance: false,
        clearInjectionId: marker.injectionId,
      });
    }

    const activeInjectionTaskIds = new Set(
      store.listInjections().map((marker) => marker.taskId),
    );
    const tasks = store.listTasks();
    const plan = planTick({
      tasks,
      isOccupied: (sessionId) => occupancy.isOccupied(sessionId),
      activeInjectionTaskIds,
      running: this.inFlight.size,
      concurrency,
      now: at,
    });

    for (const item of plan.inject) {
      if (store.listInjectionsForTask(item.task.id).length > 0) continue;
      if (item.task.target.kind !== "session") continue;
      const holder = occupancy.getUniqueHolder(item.task.target.sessionId);
      const marker: InjectionMarker = {
        injectionId: `${item.task.id}:${item.scheduledTime}`,
        taskId: item.task.id,
        scheduledTime: item.scheduledTime,
        prompt: item.task.prompt,
        title: item.task.title,
        sessionId: item.task.target.sessionId,
        staleAt: item.staleAt,
        phase: "pending",
        createdAt: at,
        ...(holder ? { createdForHolder: { pid: holder.pid, holderToken: holder.holderToken, bindingGen: holder.bindingGen } } : {}),
      };
      // Marker first, watermark second. reconcileCrashed repairs the watermark
      // if the daemon dies between these two durable writes.
      store.putInjection(marker);
      this.advance(item.task, item.scheduledTime);
      noteMarkerWake(marker.staleAt + 1);
    }
    for (const skip of plan.skip) {
      this.recordSkip(skip.task, skip.scheduledTime, skip.reason);
    }
    for (const retire of plan.retire) {
      this.retire(retire.task);
    }

    for (const item of plan.dispatch) {
      if (this.inFlight.has(item.task.id)) continue;
      dispatched.push(item.task.id);
      void this.execute(item.task, item.scheduledTime);
    }

    const wakeAt = minDefined(markerWakeAt, plan.wakeAt);
    return { ...(wakeAt === undefined ? {} : { wakeAt }), dispatched };
  }

  /** Return at most one earliest occurrence for this exact live binding. */
  pollInjection(request: InjectionPollInput): DaemonInjectionOffer | undefined {
    if (this.draining) return undefined;
    const holder = this.options.occupancy.getUniqueHolder(request.sessionId);
    if (
      !holder || holder.pid !== request.pid ||
      holder.holderToken !== request.holderToken ||
      holder.bindingGen !== request.bindingGen
    ) {
      return undefined;
    }

    const at = this.options.now();
    for (const original of this.options.store.listInjections()) {
      if (original.sessionId !== request.sessionId) continue;
      if (this.mailbox.reconcile(original)) continue;
      if (original.mailbox) continue;
      let marker = original;
      if (this.injectionRun(marker)) {
        this.options.store.clearInjection(marker.injectionId);
        continue;
      }
      if (marker.phase === "settled") {
        this.finalizeSettled(marker);
        continue;
      }
      if (at > marker.staleAt) {
        this.settleInjection(marker, "failure", "injection-stale");
        continue;
      }
      if (marker.phase === "leased") {
        if (
          (marker.leaseExpiresAt !== undefined && at >= marker.leaseExpiresAt) ||
          !this.markerHolderIsCurrent(marker)
        ) {
          marker = this.toAppendUncertain(marker);
        } else {
          continue;
        }
      }

      const base = this.offerBase(marker);
      if (marker.phase === "append-uncertain") {
        // Bind the subsequent proof response to the holder that received this
        // offer. No lease is minted: proof may inspect, but must never append.
        this.options.store.putInjection({
          ...marker,
          holderPid: holder.pid,
          holderToken: holder.holderToken,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          terminalDetail: undefined,
        });
        return { ...base, mode: "prove" };
      }
      if (marker.phase !== "pending") continue;

      const leaseToken = randomUUID();
      const expiresAt = Math.min(at + INJECTION_LEASE_MS, marker.staleAt);
      this.options.store.putInjection({
        ...marker,
        phase: "leased",
        leaseToken,
        leaseExpiresAt: expiresAt,
        holderPid: holder.pid,
        holderToken: holder.holderToken,
        terminalDetail: undefined,
      });
      return { ...base, mode: "append", leaseToken, expiresAt };
    }
    return undefined;
  }

  /** Commit a proven native session entry. Safe to repeat after any response loss. */
  ackInjection(request: InjectionAckInput): InjectionMutationResult {
    const recorded = this.findInjectionRun(request.injectionId);
    if (recorded) return recorded.outcome === "delivered"
      ? { ok: true }
      : { ok: false, error: "outcome=failure" };

    let marker = this.options.store.getInjection(request.injectionId);
    if (!marker) return { ok: false, error: "unknown-injection" };
    if (marker.mailbox) return { ok: false, error: "mailbox-owned-requires-terminal" };
    if (marker.phase === "settled") {
      // A settled marker from the pre-terminal-intent schema may have survived
      // after the append but before its run record. Repeated ack is the durable
      // proof: upgrade it to an explicit delivered terminal intent.
      if (!marker.terminalOutcome) {
        marker = { ...marker, terminalOutcome: "delivered" };
        this.options.store.putInjection(marker);
      }
      this.finalizeSettled(marker);
      const terminal = this.findInjectionRun(request.injectionId);
      return terminal?.outcome === "delivered"
        ? { ok: true }
        : { ok: false, error: "outcome=failure" };
    }

    const at = this.options.now();
    if (marker.phase === "leased") {
      if (marker.leaseExpiresAt !== undefined && at >= marker.leaseExpiresAt) {
        marker = this.toAppendUncertain(marker);
        return { ok: false, error: "stale-lease" };
      }
      if (!request.leaseToken || request.leaseToken !== marker.leaseToken) {
        return { ok: false, error: "stale-lease" };
      }
      if (!this.markerHolderIsCurrent(marker)) {
        this.toAppendUncertain(marker);
        return { ok: false, error: "stale-lease" };
      }
    } else if (marker.phase === "append-uncertain") {
      if (request.leaseToken !== undefined || !this.markerHolderIsCurrent(marker)) {
        return { ok: false, error: "stale-lease" };
      }
    } else {
      return { ok: false, error: "invalid-injection-state" };
    }

    this.settleInjection(marker, "delivered");
    return { ok: true };
  }

  /** Apply an explicit append disposition. No uncertain append is ever resent. */
  nackInjection(request: InjectionNackInput): InjectionMutationResult {
    const recorded = this.findInjectionRun(request.injectionId);
    if (recorded) return this.repeatedNackResult(recorded, request.reason);

    let marker = this.options.store.getInjection(request.injectionId);
    if (!marker) return { ok: false, error: "unknown-injection" };
    if (marker.mailbox) return { ok: false, error: "mailbox-owned-requires-terminal" };
    if (marker.phase === "settled") {
      this.finalizeSettled(marker);
      const terminal = this.findInjectionRun(request.injectionId);
      return terminal
        ? this.repeatedNackResult(terminal, request.reason)
        : { ok: false, error: "unknown-injection" };
    }

    // A response may be retried after its state transition but before a new
    // offer. Retain the prior lease token only for this narrow idempotency case.
    if (
      marker.terminalDetail === `nack:${request.reason}` &&
      marker.leaseToken === request.leaseToken &&
      ((marker.phase === "pending" && request.reason === "not-appended") ||
        (marker.phase === "append-uncertain" && request.reason === "append-unknown"))
    ) {
      return { ok: true };
    }

    const at = this.options.now();
    if (marker.phase === "leased") {
      if (marker.leaseExpiresAt !== undefined && at >= marker.leaseExpiresAt) {
        this.toAppendUncertain(marker);
        return { ok: false, error: "stale-lease" };
      }
      if (!request.leaseToken || request.leaseToken !== marker.leaseToken) {
        return { ok: false, error: "stale-lease" };
      }
      if (!this.markerHolderIsCurrent(marker)) {
        this.toAppendUncertain(marker);
        return { ok: false, error: "stale-lease" };
      }
      if (request.reason === "not-appended") {
        this.options.store.putInjection({
          ...marker,
          phase: "pending",
          leaseExpiresAt: undefined,
          terminalDetail: "nack:not-appended",
        });
        return { ok: true };
      }
      if (request.reason === "append-unknown") {
        this.options.store.putInjection({
          ...marker,
          phase: "append-uncertain",
          leaseExpiresAt: undefined,
          terminalDetail: "nack:append-unknown",
        });
        return { ok: true };
      }
      this.settleInjection(marker, "failure", "injection-content-conflict");
      return { ok: true };
    }

    if (marker.phase !== "append-uncertain") {
      return { ok: false, error: "invalid-injection-state" };
    }
    if (request.leaseToken !== undefined || !this.markerHolderIsCurrent(marker)) {
      return { ok: false, error: "stale-lease" };
    }
    if (request.reason === "not-appended") {
      this.settleInjection(marker, "failure", "injection-append-lost");
      return { ok: true };
    }
    if (request.reason === "content-conflict") {
      this.settleInjection(marker, "failure", "injection-content-conflict");
      return { ok: true };
    }
    return { ok: false, error: "invalid-proof-disposition" };
  }

  /** Advance a task past a skipped occurrence and log it. */
  private recordSkip(task: Task, scheduledTime: number, reason: string): void {
    const finishedAt = this.options.now();
    this.advance(task, scheduledTime);
    this.options.store.appendRun({
      taskId: task.id,
      scheduledTime,
      finishedAt,
      outcome: "skipped",
      detail: reason,
      target: task.target.kind,
    }, finishedAt);
  }

  private retire(task: Task): void {
    this.options.store.putTask({ ...task, status: "done" });
  }

  /** Persist the advanced watermark before running, so a crash mid-run does not replay it. */
  private advance(task: Task, scheduledTime: number): Task {
    const current = this.options.store.getTask(task.id) ?? task;
    const updated: Task = { ...current, lastScheduledTime: scheduledTime };
    this.options.store.putTask(updated);
    return updated;
  }

  /**
   * Reconcile crash-orphaned subprocesses and durable injection state. Marker
   * repair runs even when a daemon crashed between marker creation and advance.
   */
  reconcileCrashed(daemonAlive: (pid: number) => boolean = defaultDaemonAlive): void {
    const handoffs = new Set<string>();
    for (const marker of this.options.store.listInflight()) {
      if (marker.daemonPid === process.pid) continue;
      if (daemonAlive(marker.daemonPid)) continue;
      handoffs.add(`${marker.taskId}:${marker.scheduledTime}`);
      const alreadyRecorded = this.options.store.listRuns(marker.taskId).some(
        (run) => run.scheduledTime === marker.scheduledTime && run.startedAt === marker.startedAt,
      );
      if (!alreadyRecorded) {
        const finishedAt = this.options.now();
        const record: RunRecord = {
          taskId: marker.taskId,
          scheduledTime: marker.scheduledTime,
          startedAt: marker.startedAt,
          finishedAt,
          outcome: "failure",
          detail: "daemon exited before this run completed",
          target: marker.target,
          acknowledged: false,
        };
        this.options.store.appendRun(record, finishedAt);
        const task = this.options.store.getTask(marker.taskId);
        if (task) this.options.onFailure?.(task, record);
      }
      this.options.store.clearInflight(marker.taskId);
    }

    for (const original of this.options.store.listInjections()) {
      if (this.mailbox.reconcile(original)) continue;
      if (original.mailbox) continue;
      const task = this.options.store.getTask(original.taskId);
      if (task && (task.lastScheduledTime ?? -Infinity) < original.scheduledTime) {
        this.advance(task, original.scheduledTime);
      }
      if (handoffs.has(`${original.taskId}:${original.scheduledTime}`)) {
        this.options.store.clearInjection(original.injectionId);
        continue;
      }
      if (original.phase === "append-uncertain" ||
          (original.phase === "settled" && original.terminalOutcome !== "failure")) continue;
      if (this.injectionRun(original)) {
        this.options.store.clearInjection(original.injectionId);
        continue;
      }
      if (original.phase === "settled") {
        this.finalizeSettled(original);
        continue;
      }
      if (original.phase === "leased") {
        this.toAppendUncertain(original);
      }
    }
  }

  private markerHolderIsCurrent(marker: InjectionMarker): boolean {
    const holder = this.options.occupancy.getUniqueHolder(marker.sessionId);
    return holder !== undefined && holder.pid === marker.holderPid &&
      holder.holderToken === marker.holderToken;
  }

  private toAppendUncertain(marker: InjectionMarker): InjectionMarker {
    const updated: InjectionMarker = {
      ...marker,
      phase: "append-uncertain",
      leaseExpiresAt: undefined,
    };
    this.options.store.putInjection(updated);
    return updated;
  }

  private offerBase(marker: InjectionMarker): InjectionOfferBase {
    return {
      injectionId: marker.injectionId,
      taskId: marker.taskId,
      title: marker.title,
      prompt: marker.prompt,
      contentDigest: createHash("sha256").update(marker.prompt).digest("hex"),
      scheduledTime: marker.scheduledTime,
    };
  }

  private findInjectionRun(injectionId: string): RunRecord | undefined {
    const separator = injectionId.lastIndexOf(":");
    const taskId = separator < 0 ? injectionId : injectionId.slice(0, separator);
    return this.options.store.listRuns(taskId).find((run) => run.injectionId === injectionId);
  }

  private injectionRun(marker: InjectionMarker): RunRecord | undefined {
    return this.options.store.listRuns(marker.taskId).find(
      (run) => run.injectionId === marker.injectionId,
    );
  }

  private settleInjection(
    marker: InjectionMarker,
    outcome: "delivered" | "failure",
    detail?: string,
  ): void {
    const settled: InjectionMarker = {
      ...marker,
      phase: "settled",
      terminalOutcome: outcome,
      terminalDetail: detail,
      leaseExpiresAt: undefined,
    };
    // Persist the terminal intent first. A crash before appendRun is repaired by
    // reconcile; a crash after appendRun is deduplicated by injectionId.
    this.options.store.putInjection(settled);
    this.finalizeSettled(settled);
  }

  private finalizeSettled(marker: InjectionMarker): void {
    const existing = this.injectionRun(marker);
    if (existing) {
      this.options.store.clearInjection(marker.injectionId);
      return;
    }
    if (!marker.terminalOutcome) return;
    const finishedAt = this.options.now();
    const record: RunRecord = {
      taskId: marker.taskId,
      scheduledTime: marker.scheduledTime,
      finishedAt,
      outcome: marker.terminalOutcome,
      detail: marker.terminalDetail,
      target: "session",
      injectionId: marker.injectionId,
      acknowledged: marker.terminalOutcome === "failure" ? false : undefined,
    };
    this.options.store.appendRun(record, finishedAt);
    this.options.store.clearInjection(marker.injectionId);
    if (record.outcome === "failure") {
      const task = this.options.store.getTask(marker.taskId);
      if (task) this.options.onFailure?.(task, record);
    }
  }

  private repeatedNackResult(
    record: RunRecord,
    reason: InjectionNackReason,
  ): InjectionMutationResult {
    if (record.outcome !== "failure") return { ok: false, error: `outcome=${record.outcome}` };
    const expected = reason === "content-conflict"
      ? "injection-content-conflict"
      : reason === "not-appended"
      ? "injection-append-lost"
      : undefined;
    return expected !== undefined && record.detail === expected
      ? { ok: true }
      : { ok: false, error: "outcome=failure" };
  }

  private async execute(
    task: Task,
    scheduledTime: number,
    options: { advance?: boolean; clearInjectionId?: string } = {},
  ): Promise<void> {
    this.inFlight.add(task.id);
    const startedAt = this.options.now();
    if (options.advance !== false) this.advance(task, scheduledTime);
    this.options.store.markInflight({
      taskId: task.id,
      scheduledTime,
      startedAt,
      target: task.target.kind,
      daemonPid: process.pid,
    });
    // Session-free marker handoff is crash-safe in this order: startup sees an
    // inflight marker if the daemon exits before the injection marker clears.
    if (options.clearInjectionId) {
      this.options.store.clearInjection(options.clearInjectionId);
    }
    let result: ExecutionResult;
    try {
      result = await this.options.runner({
        task,
        scheduledTime,
        piBinary: this.options.piBinary,
      });
    } catch (error) {
      result = {
        outcome: "failure",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const finishedAt = this.options.now();
    const record: RunRecord = {
      taskId: task.id,
      scheduledTime,
      startedAt,
      finishedAt,
      outcome: result.outcome,
      detail: result.detail,
      target: task.target.kind,
      acknowledged: result.outcome === "failure" ? false : undefined,
    };
    try {
      this.options.store.appendRun(record, finishedAt);
      this.options.store.clearInflight(task.id);
      if (result.outcome === "failure") this.options.onFailure?.(task, record);
    } finally {
      this.inFlight.delete(task.id);
    }
  }
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}
