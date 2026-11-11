/**
 * Executor: turns a due task into a real Pi invocation (decisions #1/#9/#10/
 * #21). Both target kinds run a frozen prompt via `pi --print`; the difference
 * is only which session it lands in.
 *
 * - agent target: a fresh session (`--session-id <new-uuid>`) with the frozen
 *   cwd/provider/model/thinking. Each periodic run is a new session (#11).
 * - session target: `--session <sessionId> --print`, which resumes that
 *   session and appends the prompt. The daemon only calls this when the
 *   occupancy registry says no live Pi holds the session (#13), so two
 *   processes never write the same session.
 *
 * The spawn itself is injected so the daemon and its tests do not depend on a
 * real binary; `defaultRunner` is the production implementation.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Task } from "./task.ts";

export interface ExecutionResult {
  outcome: "success" | "failure";
  detail?: string;
}

export interface ExecutionRequest {
  task: Task;
  scheduledTime: number;
  /** Absolute path to the pi binary. */
  piBinary: string;
  /** Signals cancellation (daemon shutdown). */
  signal?: AbortSignal;
}

export type TaskRunner = (request: ExecutionRequest) => Promise<ExecutionResult>;

/** Build the argv for a task, exposed for tests and diagnostics. */
export function buildPiArgs(task: Task): { args: string[]; cwd?: string } {
  if (task.target.kind === "agent") {
    const args = [
      "--print",
      "--session-id", randomUUID(),
      "--provider", task.target.provider,
      "--model", task.target.model,
    ];
    if (task.target.thinking) args.push("--thinking", task.target.thinking);
    args.push("--", task.prompt);
    return { args, cwd: task.target.cwd };
  }
  // session target: resume the exact session and append the prompt. Spawn from
  // the session's own cwd so Pi resolves it in the right project namespace
  // instead of prompting to fork it into another directory. A session target
  // without a frozen cwd (e.g. a task persisted before cwd became required)
  // must fail closed rather than resume from the daemon's cwd and silently
  // no-op on Pi's cross-project fork prompt.
  if (!task.target.cwd) {
    throw new Error(
      "session target has no frozen cwd; refusing to resume from the daemon cwd",
    );
  }
  const args = ["--print", "--session", task.target.sessionId];
  if (task.target.sessionDir) args.push("--session-dir", task.target.sessionDir);
  args.push("--", task.prompt);
  return { args, cwd: task.target.cwd };
}

/** Production runner: spawn `pi --print`, capture failure detail. */
export const defaultRunner: TaskRunner = (request) =>
  new Promise<ExecutionResult>((resolve) => {
    const { task, piBinary, signal } = request;
    const { args, cwd } = buildPiArgs(task);
    const child = spawn(piBinary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      // Keep only the tail; a runaway tool must not grow memory unbounded.
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once("error", (error) => {
      resolve({ outcome: "failure", detail: `spawn failed: ${error.message}` });
    });
    child.once("close", (code, sig) => {
      if (code === 0) return resolve({ outcome: "success" });
      const why = sig ? `signal ${sig}` : `exit ${code}`;
      resolve({ outcome: "failure", detail: `${why}${stderr ? `: ${stderr.trim()}` : ""}` });
    });
  });
