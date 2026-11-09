import { spawn } from "node:child_process";

/** Give the command's entire process group time to exit before escalating. */
const KILL_GRACE_MS = 2_000;
// Cancellation has no frame to preserve. Bound teardown to one second even
// when a descendant holds a pipe or kill(-pgid, 0) keeps seeing a zombie.
const ABORT_KILL_GRACE_MS = 250;
const KILL_DRAIN_MS = 750;
const EXIT_POLL_MS = 20;

function parseOutput(stdout: string): string[] {
  const text = stdout.trim().replace(/\r\n/g, "\n");
  return text ? text.split("\n") : [];
}

export async function runStatusLineCommand(
  command: string,
  payload: unknown,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string[]> {
  return await new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      shell: true,
      // On POSIX, -pid addresses only this command and its descendants. Never
      // signal the agent's own process group or infer ownership from ps text.
      detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let settled = false;
    let closed = false, stopping = false, aborted = false;
    let exitCode: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let killDeadline = Infinity;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let exitPoll: ReturnType<typeof setTimeout> | null = null;

    const groupAlive = () => {
      if (!grouped || !child.pid) return !closed;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const signalCommand = (kind: "SIGTERM" | "SIGKILL") => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {
        // The owned group already exited; close still drains its output.
      }
    };

    const finish = (lines: string[]) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (exitPoll) clearTimeout(exitPoll);
      if (signal) signal.removeEventListener("abort", abortHandler);
      resolve(lines);
    };

    const complete = () => {
      if (!closed || (stopping && groupAlive())) return;
      finish(!aborted && exitCode === 0 ? parseOutput(stdout) : []);
    };
    const armKill = (graceMs: number) => {
      const deadline = performance.now() + graceMs;
      // Abort and timeout can arrive in either order. Teardown may only move
      // forward: keep an earlier KILL (and its drain deadline) already armed.
      if (drainTimer || deadline >= killDeadline) return;
      killDeadline = deadline;
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        signalCommand("SIGKILL");
        // `close` waits for inherited stdout/stderr as well as child exit;
        // group existence is not proof that an executable process remains.
        // Neither is a safe unbounded completion condition after SIGKILL.
        drainTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          // Keep Node's exit listener/handle alive to reap our direct child.
          // Destroying the pipes releases our fds without waiting for writers.
          finish([]);
        }, Math.max(0, killDeadline + KILL_DRAIN_MS - performance.now()));
      }, Math.max(0, killDeadline - performance.now()));
    };
    const terminate = () => {
      if (settled) return;
      if (stopping) {
        // Shutdown can arrive while the ordinary timeout is in its 2s grace.
        if (aborted && !drainTimer) armKill(ABORT_KILL_GRACE_MS);
        return;
      }
      stopping = true;
      signalCommand("SIGTERM");
      armKill(aborted ? ABORT_KILL_GRACE_MS : KILL_GRACE_MS);
      const poll = () => {
        complete();
        if (!settled) exitPoll = setTimeout(poll, EXIT_POLL_MS);
      };
      poll();
    };
    const abortHandler = () => {
      aborted = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      terminate();
    };

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      // 防止外部状态栏脚本长期挂起，阻塞后续刷新。
      //
      // Killing is not deciding. Node runs the timers phase ahead of the I/O
      // phase, so a command that has already exited can still have its timeout
      // fire first, with its last `data` and its `close` sitting unread in the
      // poll queue — which is the normal state of affairs at startup and after
      // `/reload`, when rebuilding the transcript blocks the loop for seconds.
      // Resolving [] from here would throw away a frame that had in fact been
      // produced, and at those two moments there is no previous frame to fall
      // back on. So the timeout only takes the process down; `close` below
      // still says what the run produced.
      timeout = setTimeout(terminate, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.on("error", () => {
      finish([]);
    });

    // A command that exits without draining stdin leaves the write below to
    // fail on EPIPE, and an unhandled 'error' on a stream takes the process
    // down with it.
    child.stdin.on("error", () => {
      // The command not reading its payload is its own business.
    });

    child.on("close", (code) => {
      closed = true;
      exitCode = code;
      complete();
    });

    // Install all process/stream listeners before handling an already-aborted
    // signal: spawn/error/close can still arrive during cancellation.
    if (signal?.aborted) { abortHandler(); return; }
    signal?.addEventListener("abort", abortHandler, { once: true });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
