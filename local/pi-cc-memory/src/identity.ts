import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createVersionedReader } from "./file-cache.ts";

const exec = promisify(execFile);
// `git rev-parse` answers in milliseconds on an idle machine, but discovery also runs
// while the machine is loaded (load average over 100 in the reported failure), where
// spawn and process-table pressure alone exceeded the old 5s budget. 15s per attempt
// keeps that headroom; the retry below caps one Git call at two attempts.
const GIT_TIMEOUT_MS = 15_000;
// A timeout under load is transient, so one retry recovers it. Other failures (missing
// Git, damaged markers, refused spawn) are not retried: the result must stay reproducible.
const GIT_ATTEMPTS = 2;

/** One `git` invocation; defaults to `execFile`, replaced by tests. */
export type GitRunner = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface ProjectDiscoveryOptions {
  /** One Git command, with the timeout and buffer budget it must honour; defaults to `execFile`. */
  readonly runGit?: GitRunner;
}

export type ProjectIdentity =
  | { available: true; identity: string; memoryDir: string; warning?: string }
  | { available: false; warning: string };

/** Include files, directories and dangling symlinks: an unusable marker is still a boundary. */
async function nearestGitMarker(cwd: string, stopAt?: string, rejectHead = false): Promise<string | undefined> {
  for (let directory = cwd;; directory = dirname(directory)) {
    if (rejectHead) {
      // A possible bare/admin boundary before .git makes a cached outer identity unprovable.
      try { await lstat(join(directory, "HEAD")); return undefined; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const marker = join(directory, ".git");
    try {
      await lstat(marker);
      return marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === stopAt || dirname(directory) === directory) return undefined;
  }
}

/** Directory writes (index locks, refs, etc.) do not change project identity. */
async function directoryStamp(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error(`Not a Git directory: ${path}`);
  return [path, "directory", stat.dev.toString(), stat.ino.toString()];
}

/** Walk again so a new inner marker cannot inherit the previously resolved outer repository. */
async function boundaryFingerprint(cwd: string, readPointer: (path: string) => Promise<string>): Promise<{ key: string; commonDir: string } | undefined> {
  const marker = await nearestGitMarker(cwd, undefined, true);
  // Bare/admin discovery has no .git boundary we can prove here; always leave it to Git.
  if (!marker) return undefined;
  const target = await realpath(marker);
  const stat = await lstat(target);
  let admin = target;
  let gitfile: { path: string; content: string } | undefined;
  if (stat.isFile()) {
    gitfile = { path: target, content: await readPointer(target) };
    const match = /^gitdir: (.+)$/.exec(gitfile.content.replace(/\r?\n$/, ""));
    if (!match) throw new Error(`Invalid gitfile ${marker}`);
    admin = await realpath(resolve(dirname(marker), match[1]!));
  }
  const commonPointer = join(admin, "commondir");
  let hasCommonPointer = true;
  try { await lstat(commonPointer); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hasCommonPointer = false;
  }
  let commondir: { path: string; content: string } | undefined;
  let commonDir = admin;
  if (hasCommonPointer) {
    // Follow symlinks to the actual pointer file; its current contents choose the common dir.
    const path = await realpath(commonPointer);
    if (!(await lstat(path)).isFile()) throw new Error(`Invalid commondir ${commonPointer}`);
    commondir = { path, content: await readPointer(path) };
    commonDir = await realpath(resolve(admin, commondir.content.trimEnd()));
  }
  const directories = await Promise.all([...new Set([admin, commonDir])].map(directoryStamp));
  return { key: JSON.stringify([cwd, marker, target, gitfile, commondir, directories]), commonDir };
}

/** One successful marked Git identity per session; unprovable boundaries always retry discovery. */
export function createProjectResolver() {
  const readPointer = createVersionedReader((path: string) => readFile(path, "utf8"));
  let cached: { agentDir: string; path: string | undefined; boundary: string; project: ProjectIdentity } | undefined;
  return async (cwd: string, agentDir: string): Promise<ProjectIdentity> => {
    let boundary: Awaited<ReturnType<typeof boundaryFingerprint>>;
    try {
      boundary = await boundaryFingerprint(await realpath(cwd), readPointer);
      if (boundary && cached && cached.agentDir === agentDir && cached.path === process.env.PATH && cached.boundary === boundary.key) {
        return cached.project;
      }
    } catch { /* A failed fingerprint must use full Git discovery, never a stale identity. */ }
    cached = undefined;
    const project = await resolveProject(cwd, agentDir);
    if (project.available && !project.warning && boundary && project.identity === `git:${boundary.commonDir}`) {
      try {
        if ((await boundaryFingerprint(await realpath(cwd), readPointer))?.key === boundary.key) {
          cached = { agentDir, path: process.env.PATH, boundary: boundary.key, project };
        }
      } catch { /* Resolution succeeded, but an unverifiable result is not cached. */ }
    }
    return project;
  };
}

/** `execFile` reports a child it killed for exceeding its timeout as killed by SIGTERM with no exit code. */
function isGitTimeout(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown };
  return failure?.killed === true && failure.signal === "SIGTERM";
}

/** Timeouts retry once; anything else fails as it did, so results stay reproducible. */
async function discoverGit(args: string[], run: GitRunner, env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run("git", args, { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    } catch (error) {
      if (!isGitTimeout(error) || attempt >= GIT_ATTEMPTS) throw error;
    }
  }
}

/** Full discovery remains the fallback whenever the filesystem fingerprint cannot be trusted. */
export async function resolveProject(cwd: string, agentDir: string, options: ProjectDiscoveryOptions = {}): Promise<ProjectIdentity> {
  const git = options.runGit ?? exec;
  try {
    const canonicalCwd = await realpath(cwd);
    let identity: string;
    let warning: string | undefined;
    let commonDir: string | undefined;
    // Discovery belongs to cwd, not the caller's Git invocation/config/discovery overrides.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const gitEnv = { ...env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
    try {
      const { stdout } = await discoverGit(["-C", canonicalCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], git, gitEnv);
      // Git terminates the path with one newline; preserve whitespace in actual path names.
      commonDir = stdout.replace(/\r?\n$/, "");
      identity = "";
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === "ENOENT") {
        identity = `dir:${canonicalCwd}`;
        warning = "pi-cc-memory：Git 不可用，按启动目录使用记忆，无法保证 worktree 共用。";
      } else if (/^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(failure.stderr?.trim() ?? "")) {
        const marker = await nearestGitMarker(canonicalCwd);
        if (marker) throw new Error(`Git 无法使用已有标记 ${marker}，拒绝按非 Git 目录回退。`);
        identity = `dir:${canonicalCwd}`;
      } else {
        throw error;
      }
    }
    if (commonDir !== undefined) {
      const canonicalCommonDir = await realpath(commonDir);
      // Stop at a containing bare/admin directory; markers above it belong to another project.
      const marker = await nearestGitMarker(canonicalCwd, canonicalCommonDir);
      if (marker) {
        // Explicit --git-dir validates directories AND gitfiles, without skipping a broken inner repo.
        const { stdout } = await discoverGit(["-C", canonicalCwd, "--git-dir", marker, "rev-parse", "--path-format=absolute", "--git-common-dir"], git, gitEnv);
        if (await realpath(stdout.replace(/\r?\n$/, "")) !== canonicalCommonDir) {
          throw new Error(`Git 发现结果与最近标记 ${marker} 不一致。`);
        }
      }
      identity = `git:${canonicalCommonDir}`;
    }
    const key = createHash("sha256").update(identity).digest("hex");
    return { available: true, identity, memoryDir: join(agentDir, "pi-cc-memory", "projects", key, "memory"), warning };
  } catch (error) {
    // A timeout says why discovery stopped; the bare `Command failed: git ...` text does not.
    const message = error instanceof Error ? error.message : String(error);
    const warning = isGitTimeout(error)
      ? `pi-cc-memory：Git 超时（${GIT_TIMEOUT_MS / 1000} 秒），暂不注入记忆。`
      : `pi-cc-memory：无法识别项目，暂不注入记忆。${message}`;
    return { available: false, warning };
  }
}
