import type { ProcessWaitAdmissionV2 } from "pi-runtime-contracts/process-wait-bridge-v2";

export type HostProcessWaitAdmissionV2 = ProcessWaitAdmissionV2 | "pending";

export interface ProcessWaitAdmissionRequestV2 {
  readonly admissionId: string;
  readonly taskId: string;
  readonly childIdle: boolean;
  readonly continuationSignal: boolean;
  readonly settledBoundary: boolean;
  /** In-process SDK owner confirmation; absent or stale confirmation keeps the watchdog active. */
  readonly onQueued?: (isCurrent: () => boolean) => void;
}

export interface ChildProcessWaitAdmissionOptionsV2 {
  currentTaskId(): string;
  childIdle(): boolean;
  request(input: ProcessWaitAdmissionRequestV2): Promise<HostProcessWaitAdmissionV2>;
  report(error: unknown): void;
  /** settled boundary 上 Host 无回应的上限；owner 确认仍合法排队时继续等。 */
  readonly settlementTimeoutMs?: number;
}

interface PendingAdmission {
  readonly admissionId: string;
  readonly taskId: string;
  readonly promise: Promise<ProcessWaitAdmissionV2>;
  resolve(value: ProcessWaitAdmissionV2): void;
  initialPending: boolean;
  settlementReached: boolean;
  retrying: boolean;
  settled: boolean;
  queued?: () => boolean;
}

export class ChildProcessWaitAdmissionV2 {
  readonly options: ChildProcessWaitAdmissionOptionsV2;
  #pending?: PendingAdmission;
  #cancelledTaskId?: string;

  constructor(options: ChildProcessWaitAdmissionOptionsV2) {
    this.options = options;
  }

  admit(admissionId: string, continuationSignal: boolean): Promise<ProcessWaitAdmissionV2> {
    const taskId = this.options.currentTaskId();
    if (!taskId || this.#cancelledTaskId === taskId) return Promise.resolve("record-only");
    if (this.#pending) return this.#pending.taskId === taskId && this.#pending.admissionId === admissionId
      ? this.#pending.promise
      : Promise.resolve("record-only");
    if (!continuationSignal) return this.#admitNotification(admissionId, taskId);
    let resolve!: (value: ProcessWaitAdmissionV2) => void;
    const promise = new Promise<ProcessWaitAdmissionV2>((next) => { resolve = next; });
    const pending: PendingAdmission = {
      admissionId,
      taskId,
      promise,
      resolve,
      initialPending: false,
      settlementReached: false,
      retrying: false,
      settled: false,
    };
    this.#pending = pending;
    void this.#requestInitial(pending);
    return promise;
  }

  async beforeTaskSettlement(taskId: string): Promise<boolean> {
    const pending = this.#pending;
    if (!pending || pending.taskId !== taskId || pending.settled) return false;
    pending.settlementReached = true;
    void this.#retryAtSettlement(pending);
    // A live SDK queue is not a missing Host response. Keep the watchdog for
    // requests whose owner never confirms, or no longer owns, this admission.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      timer = setTimeout(() => {
        if (this.#pending !== pending || pending.settled) return;
        if (pending.queued?.()) { watch(); return; }
        this.options.report(new Error("Process continuation admission did not answer at the settled boundary"));
        this.#finish(pending, "record-only");
      }, this.options.settlementTimeoutMs ?? 60_000);
      timer.unref?.();
    };
    watch();
    try { return await pending.promise === "trigger"; }
    finally { if (timer) clearTimeout(timer); }
  }

  cancel(taskId: string): void {
    if (this.options.currentTaskId() !== taskId && this.#pending?.taskId !== taskId) return;
    this.#cancelledTaskId = taskId;
    if (this.#pending?.taskId === taskId) this.#finish(this.#pending, "record-only");
  }

  dispose(): void {
    if (this.#pending) this.#finish(this.#pending, "record-only");
  }

  async #admitNotification(admissionId: string, taskId: string): Promise<ProcessWaitAdmissionV2> {
    try {
      const admission = await this.options.request({
        admissionId,
        taskId,
        childIdle: this.options.childIdle(),
        continuationSignal: false,
        settledBoundary: false,
      });
      return admission === "trigger" && this.options.currentTaskId() === taskId && this.#cancelledTaskId !== taskId ? "trigger" : "record-only";
    } catch (error) {
      this.options.report(error);
      return "record-only";
    }
  }

  async #requestInitial(pending: PendingAdmission): Promise<void> {
    try {
      const admission = await this.options.request({
        admissionId: pending.admissionId,
        taskId: pending.taskId,
        childIdle: this.options.childIdle(),
        continuationSignal: true,
        settledBoundary: false,
        onQueued: isCurrent => { if (this.#pending === pending && !pending.settled) pending.queued = isCurrent; },
      });
      if (this.#pending !== pending || pending.settled) return;
      if (admission !== "pending") {
        this.#finish(pending, admission);
        return;
      }
      pending.initialPending = true;
      void this.#retryAtSettlement(pending);
    } catch (error) {
      if (this.#pending !== pending || pending.settled) return;
      this.options.report(error);
      this.#finish(pending, "record-only");
    }
  }

  async #retryAtSettlement(pending: PendingAdmission): Promise<void> {
    if (this.#pending !== pending || pending.settled || !pending.initialPending || !pending.settlementReached || pending.retrying) return;
    pending.retrying = true;
    try {
      const admission = await this.options.request({
        admissionId: pending.admissionId,
        taskId: pending.taskId,
        childIdle: true,
        continuationSignal: true,
        settledBoundary: true,
        onQueued: isCurrent => { if (this.#pending === pending && !pending.settled) pending.queued = isCurrent; },
      });
      this.#finish(pending, admission === "trigger" ? "trigger" : "record-only");
    } catch (error) {
      if (this.#pending !== pending || pending.settled) return;
      this.options.report(error);
      this.#finish(pending, "record-only");
    }
  }

  #finish(pending: PendingAdmission, admission: ProcessWaitAdmissionV2): void {
    if (this.#pending !== pending || pending.settled) return;
    pending.settled = true;
    this.#pending = undefined;
    pending.resolve(admission === "trigger" && (this.options.currentTaskId() !== pending.taskId || this.#cancelledTaskId === pending.taskId) ? "record-only" : admission);
  }
}
