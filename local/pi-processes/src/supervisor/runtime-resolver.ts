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
const PROBE_TIMEOUT_MS = 2_000;

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

export async function probeRuntime(candidate: RuntimeCandidate, supervisorPath: string): Promise<RuntimeProbeSuccess | RuntimeProbeAttempt> {
  const nonce = randomBytes(16).toString("hex");
  return await new Promise((resolveResult) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const settle = (value: RuntimeProbeSuccess | RuntimeProbeAttempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    const child = spawn(candidate.path, [supervisorPath, "--runtime-probe", nonce], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= MAX_OUTPUT_BYTES) return current;
      return Buffer.concat([current, chunk.subarray(0, MAX_OUTPUT_BYTES - current.length)]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => settle({ path: candidate.path, source: candidate.source, outcome: "spawn-error", detail: error.message }));
    child.on("exit", (code, signal) => {
      if (settled) return;
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ path: candidate.path, source: candidate.source, outcome: "timeout" });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
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
