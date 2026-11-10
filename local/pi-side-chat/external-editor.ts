import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_ABORT_GRACE_MS = 1_000;

function signalEditorProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when process-group signaling is unavailable.
    }
  }
  try { child.kill(signal); }
  catch { /* The close event remains the terminal ownership proof. */ }
}

export async function editInParentTerminal(
  command: string,
  content: string,
  signal?: AbortSignal,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
): Promise<string | undefined> {
  const directory = mkdtempSync(join(tmpdir(), "pi-side-editor-"));
  chmodSync(directory, 0o700);
  const file = join(directory, "prompt.md");
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try {
    const [executable, ...args] = command.split(" ").filter(Boolean);
    if (!executable) throw new Error("External editor command is empty");
    const child = spawn(executable, [...args, file], {
      stdio: "inherit",
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    let spawnError: Error | undefined;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", (error) => {
        spawnError = error;
        if (!child.pid) reject(error);
      });
      child.once("close", resolve);
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      signalEditorProcess(child, "SIGTERM");
      killTimer = setTimeout(() => signalEditorProcess(child, "SIGKILL"), Math.max(0, abortGraceMs));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let exitCode: number | null;
    try {
      exitCode = await closed;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
    }
    if (spawnError && !signal?.aborted) throw spawnError;
    if (exitCode !== 0 || signal?.aborted) return undefined;
    return readFileSync(file, "utf8").replace(/\n$/u, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
