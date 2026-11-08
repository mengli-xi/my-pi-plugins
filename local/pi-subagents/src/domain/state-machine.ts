import type {
  AgentState,
  RuntimeResidency,
  TaskEvent,
  TaskState,
  TaskTransitionResult,
} from "./types.js";

const TERMINAL_OUTCOMES = new Set(["completed", "partial", "blocked", "failed", "interrupted"]);
const TERMINAL_REASONS = new Set([
  "normal-final",
  "finish-task",
  "timeout",
  "host-lost",
  "user-interrupt",
  "parent-interrupt",
  "provider-error",
  "tool-error",
  "user-input-required",
  "approval-required",
  "runtime-crash",
  "protocol-error",
  "capability-drift",
  "credential-unavailable",
  "storage-error",
]);

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function assertTaskState(state: TaskState): void {
  if (
    state.leaseDisposition !== "required" &&
    state.leaseDisposition !== "release-pending" &&
    state.leaseDisposition !== "released"
  ) {
    throw new Error("invalid lease disposition");
  }
  const hasStart = state.startedAt !== undefined || state.deadlineAtMs !== undefined || state.runtimeGeneration !== undefined;
  const hasSettlement = state.settledAt !== undefined || state.outcome !== undefined || state.reason !== undefined || state.completionId !== undefined;
  if (state.phase === "admitted") {
    if (hasStart || state.waitingOn || hasSettlement || state.leaseDisposition !== "required") {
      throw new Error("admitted task has runtime, waiting, settlement, or released lease fields");
    }
    return;
  }
  if (state.phase === "starting" || state.phase === "running" || state.phase === "waiting") {
    if (!state.startedAt || !positiveSafeInteger(state.deadlineAtMs) || !positiveSafeInteger(state.runtimeGeneration)) {
      throw new Error(`${state.phase} task requires start, deadline, and runtime generation`);
    }
    if (hasSettlement || state.leaseDisposition !== "required") {
      throw new Error(`${state.phase} task cannot be settled or release its lease`);
    }
    if ((state.phase === "waiting") !== (state.waitingOn !== undefined)) {
      throw new Error("waiting_on must exist only in waiting phase");
    }
    if (
      state.interruptRequestedAt !== undefined &&
      state.interruptGeneration !== state.runtimeGeneration
    ) {
      throw new Error("interrupt generation must equal current runtime generation");
    }
    return;
  }
  if (state.phase === "settled") {
    if (!state.settledAt || !state.outcome || !state.reason || !state.completionId || state.waitingOn) {
      throw new Error("settled task requires complete outcome fields and no waiting state");
    }
    if (!TERMINAL_OUTCOMES.has(state.outcome) || !TERMINAL_REASONS.has(state.reason)) {
      throw new Error("settled task has unknown outcome or reason");
    }
    if (state.leaseDisposition === "required") throw new Error("settled task lease must be release-pending or released");
    return;
  }
  throw new Error("unknown task phase");
}

function stale(state: TaskState): TaskTransitionResult {
  return { state, changed: false, stale: true };
}

function changed(state: TaskState): TaskTransitionResult {
  assertTaskState(state);
  return { state, changed: true, stale: false };
}

export function reduceTask(state: TaskState, event: TaskEvent): TaskTransitionResult {
  assertTaskState(state);
  if (state.phase === "settled") {
    if (event.type === "mark-lease-released" && state.leaseDisposition === "release-pending") {
      return changed({ ...state, leaseDisposition: "released" });
    }
    return stale(state);
  }

  switch (event.type) {
    case "start":
      if (state.phase !== "admitted") return stale(state);
      if (!positiveSafeInteger(event.deadlineAtMs) || !positiveSafeInteger(event.runtimeGeneration)) {
        throw new Error("start requires positive deadline and runtime generation");
      }
      return changed({
        ...state,
        phase: "starting",
        startedAt: event.startedAt,
        deadlineAtMs: event.deadlineAtMs,
        runtimeGeneration: event.runtimeGeneration,
      });
    case "begin-running":
      if (state.phase !== "starting" || state.runtimeGeneration !== event.runtimeGeneration) return stale(state);
      return changed({ ...state, phase: "running" });
    case "begin-wait":
      if (state.phase !== "running" || state.runtimeGeneration !== event.runtimeGeneration) return stale(state);
      return changed({ ...state, phase: "waiting", waitingOn: event.waitingOn });
    case "dependency-ready":
      if (state.phase !== "waiting" || state.runtimeGeneration !== event.runtimeGeneration) return stale(state);
      return changed({ ...state, phase: "running", waitingOn: undefined });
    case "request-interrupt":
      if (
        (state.phase !== "starting" && state.phase !== "running" && state.phase !== "waiting") ||
        state.runtimeGeneration !== event.runtimeGeneration
      ) {
        return stale(state);
      }
      if (state.interruptRequestedAt !== undefined) return stale(state);
      return changed({
        ...state,
        interruptRequestedAt: event.requestedAt,
        interruptGeneration: event.runtimeGeneration,
      });
    case "settle":
      if (
        (state.phase !== "starting" && state.phase !== "running" && state.phase !== "waiting") ||
        state.runtimeGeneration !== event.runtimeGeneration
      ) {
        return stale(state);
      }
      return changed({
        ...state,
        phase: "settled",
        waitingOn: undefined,
        settledAt: event.settledAt,
        outcome: event.outcome,
        reason: event.reason,
        completionId: event.completionId,
        leaseDisposition: "release-pending",
      });
    case "mark-lease-released":
      return stale(state);
  }
}

export interface AgentStateInput {
  readonly available: boolean;
  readonly currentTask?: Pick<TaskState, "phase">;
  readonly queuedTasks: number;
  readonly residency: RuntimeResidency;
}

export function deriveAgentState(input: AgentStateInput): AgentState {
  if (!input.available) return "unavailable";
  if (!Number.isSafeInteger(input.queuedTasks) || input.queuedTasks < 0) {
    throw new Error("queuedTasks must be a non-negative safe integer");
  }
  const phase = input.currentTask?.phase;
  if (phase === "starting") return "starting";
  if (phase === "running") return "running";
  if (phase === "waiting") {
    if (input.residency !== "resident") throw new Error("waiting Agent must remain resident in V1");
    return "waiting";
  }
  if (phase === "admitted" || input.queuedTasks > 0) return "queued";
  if (phase === "settled") throw new Error("settled task cannot remain current");
  return "idle";
}
