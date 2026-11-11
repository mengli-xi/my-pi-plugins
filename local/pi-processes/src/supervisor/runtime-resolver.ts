import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface RuntimeCandidate {
  path: string;
  source: "process.execPath" | "PATH" | "explicit";
}

export interface RuntimeProbeSuccess {
  candidate: RuntimeCandidate;
  engine: "node" | "bun";
  version: string;
}

export interface RuntimeProbeAttempt {
  path: string;
  source: RuntimeCandidate["source"];
  outcome: "accepted" | "not-found" | "not-executable" | "timeout" | "invalid-output" | "unsupported-version" | "spawn-error";
  detail?: string;
}

export interface ResolveRuntimeResult {
  runtime?: RuntimeProbeSuccess;
  attempts: RuntimeProbeAttempt[];
}

const MAX_OUTPUT_BYTES = 65_536;
// Cold runtime startup can be delayed by scheduler pressure. Only a timeout is transient.
const PROBE_TIMEOUT_MS = 10_000;
const PIPE_EXIT_GRACE_MS = 2_000;
const PROBE_CLEANUP_TIMEOUT_MS = 2_000;

function basenameKind(path: string): "node" | "bun" | undefined {
  const base = path.split(/[\\/]/).at(-1)?.toLowerCase();
  if (base === "node" || base === "node.exe") return "node";
  if (base === "bun" || base === "bun.exe") return "bun";
  return undefined;
}

function versionAtLeast(actual: string, minimum: [number, number]): boolean {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?/.exec(actual);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

async function executableRealPath(path: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(path);
    const info = await lstat(resolved);
    if (!info.isFile()) return undefined;
    await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

export async function collectRuntimeCandidates(options: {
  helperRuntime: "auto" | string;
  processExecPath?: string;
  pathValue?: string;
}): Promise<RuntimeCandidate[]> {
  if (options.helperRuntime !== "auto") {
    if (!isAbsolute(options.helperRuntime)) return [];
    const path = await executableRealPath(options.helperRuntime);
    return path ? [{ path, source: "explicit" }] : [];
  }
  const candidates: RuntimeCandidate[] = [];
  const seen = new Set<string>();
  const add = async (path: string, source: RuntimeCandidate["source"]): Promise<void> => {
    if (!basenameKind(path)) return;
    const resolved = await executableRealPath(path);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push({ path: resolved, source });
  };
  if (options.processExecPath && basenameKind(options.processExecPath)) {
    await add(options.processExecPath, "process.execPath");
  }
  const directories = (options.pathValue ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const executable of ["bun", "node"]) {
    for (const directory of directories) await add(resolve(directory, executable), "PATH");
  }
  return candidates;
}

async function probeRuntimeOnce(candidate: RuntimeCandidate, supervisorPath: string, timeoutMs: number): Promise<RuntimeProbeSuccess | RuntimeProbeAttempt> {
  const nonce = randomBytes(16).toString("hex");
  return await new Promise((resolveResult) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let timeoutDetail: string;
    let timer: NodeJS.Timeout | undefined;
    let pipeTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const settle = (value: RuntimeProbeSuccess | RuntimeProbeAttempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      clearTimeout(cleanupTimer);
      resolveResult(value);
    };
    const child = spawn(candidate.path, [supervisorPath, "--runtime-probe", nonce], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
    });
    const expire = (detail: string): void => {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutDetail = detail;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      // A detached descendant can escape this group and retain its pipes. Do
      // not let that descendant decide whether a probe (or its retry) finishes.
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle({ path: candidate.path, source: candidate.source, outcome: "timeout",
          detail: `${timeoutDetail}; pipes forcibly closed after ${PROBE_CLEANUP_TIMEOUT_MS}ms cleanup` });
      }, PROBE_CLEANUP_TIMEOUT_MS);
      cleanupTimer.unref?.();
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    };
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= MAX_OUTPUT_BYTES) return current;
      return Buffer.concat([current, chunk.subarray(0, MAX_OUTPUT_BYTES - current.length)]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      // A kill error must not cancel the bounded pipe cleanup already in flight.
      if (!timedOut) settle({ path: candidate.path, source: candidate.source, outcome: "spawn-error", detail: error.message });
    });
    child.once("exit", () => {
      if (settled || timedOut) return;
      pipeTimer = setTimeout(() => expire(`pipes remained open ${PIPE_EXIT_GRACE_MS}ms after runtime exit`), PIPE_EXIT_GRACE_MS);
      pipeTimer.unref?.();
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        settle({ path: candidate.path, source: candidate.source, outcome: "timeout", detail: timeoutDetail });
        return;
      }
      const line = stdout.toString("utf8");
      const match = new RegExp(`^pi-processes-runtime-v1 ${nonce} (node|bun) ([^\\s]+)\\n?$`).exec(line);
      if (code !== 0 || signal || !match || stderr.length > 0) {
        settle({ path: candidate.path, source: candidate.source, outcome: "invalid-output", detail: `exit=${String(code)} signal=${String(signal)}` });
        return;
      }
      const engine = match[1] as "node" | "bun";
      const version = match[2]!;
      if ((engine === "node" && !versionAtLeast(version, [20, 0])) || (engine === "bun" && !versionAtLeast(version, [1, 2]))) {
        settle({ path: candidate.path, source: candidate.source, outcome: "unsupported-version", detail: `${engine} ${version}` });
        return;
      }
      settle({ candidate, engine, version });
    });
    timer = setTimeout(() => expire(`probe exceeded ${timeoutMs}ms`), timeoutMs);
    timer.unref?.();
  });
}

export async function probeRuntime(candidate: RuntimeCandidate, supervisorPath: string): Promise<RuntimeProbeSuccess | RuntimeProbeAttempt> {
  const first = await probeRuntimeOnce(candidate, supervisorPath, PROBE_TIMEOUT_MS);
  if ("candidate" in first || first.outcome !== "timeout") return first;
  const second = await probeRuntimeOnce(candidate, supervisorPath, PROBE_TIMEOUT_MS);
  if ("candidate" in second) return second;
  const describe = (attempt: RuntimeProbeAttempt): string => `${attempt.outcome}${attempt.detail ? ` (${attempt.detail})` : ""}`;
  return { ...second, detail: `first attempt: ${describe(first)}; retry: ${describe(second)}` };
}

export async function resolveHelperRuntime(options: {
  helperRuntime: "auto" | string;
  supervisorPath: string;
  processExecPath?: string;
  pathValue?: string;
}): Promise<ResolveRuntimeResult> {
  const candidates = await collectRuntimeCandidates(options);
  const attempts: RuntimeProbeAttempt[] = [];
  if (candidates.length === 0 && options.helperRuntime !== "auto") {
    attempts.push({ path: options.helperRuntime, source: "explicit", outcome: "not-executable" });
  }
  for (const candidate of candidates) {
    const result = await probeRuntime(candidate, options.supervisorPath);
    if ("candidate" in result) return { runtime: result, attempts };
    attempts.push(result);
  }
  return { attempts };
}
