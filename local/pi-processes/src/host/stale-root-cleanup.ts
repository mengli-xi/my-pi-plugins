import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 启动时一次性回收「owner 已确认死亡」的私有 log root。
 *
 * root 由 SupervisorClient 在 os.tmpdir() 下创建，名字是 `pi-processes-<Pi PID>-<64 hex nonce>`。
 * 正常 session 结束仍由 scope cleanup 删除自己的 root；这里只处理 hard crash 留下的遗留目录。
 * 判断死亡只用 `process.kill(pid, 0)`：ESRCH 才算不存在，EPERM、成功和任何其它 error 都保留。
 * 本模块绝不向任何进程发送信号，也绝不读取 log 内容。
 *
 * 一轮最多检查 64 个 root。500 ms 是开始下一个 root 之前检查的软预算，不是硬上限：
 * 枚举 base 与已经开始的那个 root 的文件操作可能超出它。
 */

const ROOT_NAME = /^pi-processes-([1-9]\d{0,9})-([0-9a-f]{64})$/;
const NONCE = /^[0-9a-f]{64}$/;
const SEGMENT_NAME = /^proc_[0-9a-z]{12}\.[0-9a-f]{8}\.jsonl$/;
const INDEX_NAME = /^proc_[0-9a-z]{12}\.index(?:\.tmp)?$/;
const MARKER_NAME = "supervisor.json";
const RECORDS_NAME = "records";
const MARKER_KEYS = "generation,hostNonce,piPid,supervisorPid,version";
const MARKER_MAX_BYTES = 4096;
const RECORDS_MAX_ENTRIES = 4096;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** 单次启动最多检查的 root 数量；剩下的留给下一次启动。 */
export const STALE_ROOT_MAX_PER_START = 64;
/**
 * 单次启动的软预算（soft admission budget）：只在开始下一个 root 之前检查。
 * 枚举 base 与已经开始的那个 root 的文件操作可能超出它，超出不算清理失败。
 */
export const STALE_ROOT_BUDGET_MS = 500;

export type StaleRootSkipReason =
  | "name-mismatch"
  | "self-root"
  | "owner-alive"
  | "owner-unknown"
  | "not-a-directory"
  | "foreign-owner"
  | "mode-mismatch"
  | "unknown-entry"
  | "layout-too-large"
  | "marker-missing"
  | "marker-invalid"
  | "marker-version-unknown"
  | "identity-mismatch"
  | "identity-changed"
  | "vanished"
  | "inspect-failed"
  | "remove-failed";

const SKIP_REASONS: readonly StaleRootSkipReason[] = [
  "name-mismatch", "self-root", "owner-alive", "owner-unknown", "not-a-directory",
  "foreign-owner", "mode-mismatch", "unknown-entry", "layout-too-large", "marker-missing",
  "marker-invalid", "marker-version-unknown", "identity-mismatch", "identity-changed",
  "vanished", "inspect-failed", "remove-failed",
];

export interface StaleRootCleanupSummaryV1 {
  readonly version: 1;
  readonly base: string;
  /** base 下名字匹配 root 命名规则的目录总数。 */
  readonly scanned: number;
  /** 本次实际检查的数量。 */
  readonly inspected: number;
  readonly removed: number;
  /** 因 root 数量上限或软预算已用完，没有开始检查、留给下一次启动的数量。 */
  readonly deferred: number;
  readonly durationMs: number;
  readonly scanFailed: boolean;
  readonly skipped: Readonly<Record<StaleRootSkipReason, number>>;
}

export type KillProbe = (pid: number, signal: 0) => void;

export interface StaleRootCleanupOptions {
  /** 扫描哪个目录；默认 os.tmpdir()。只有 unit test 会传它，生产代码不读任何环境变量。 */
  readonly base?: string;
  readonly selfPid?: number;
  readonly uid?: number;
  readonly maxRoots?: number;
  readonly budgetMs?: number;
  readonly kill?: KillProbe;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly report?: (summary: StaleRootCleanupSummaryV1) => void;
}

interface SupervisorMarkerV1 {
  readonly version: 1;
  readonly hostNonce: string;
  readonly piPid: number;
  readonly supervisorPid: number;
  readonly generation: number;
}

interface ResolvedOptions {
  readonly base: string;
  readonly selfPid: number;
  readonly uid: number;
  readonly maxRoots: number;
  readonly budgetMs: number;
  readonly kill: KillProbe;
  readonly now: () => number;
  readonly random: () => number;
  readonly report: (summary: StaleRootCleanupSummaryV1) => void;
}

type Identity = { readonly marker: SupervisorMarkerV1 } | { readonly reason: StaleRootSkipReason };
type Outcome = { readonly removed: true } | { readonly removed: false; readonly reason: StaleRootSkipReason };

function debugReport(summary: StaleRootCleanupSummaryV1): void {
  if (process.env.PI_PROCESSES_DEBUG !== "1") return;
  const skipped: Record<string, number> = {};
  for (const reason of SKIP_REASONS) {
    const count = summary.skipped[reason];
    if (count > 0) skipped[reason] = count;
  }
  process.stderr.write(`${JSON.stringify({
    source: "pi-processes",
    event: "stale-root-scavenged",
    scanned: summary.scanned,
    inspected: summary.inspected,
    removed: summary.removed,
    deferred: summary.deferred,
    durationMs: Math.round(summary.durationMs),
    scanFailed: summary.scanFailed,
    skipped,
  })}\n`);
}

function resolveOptions(options: StaleRootCleanupOptions): ResolvedOptions {
  return {
    base: options.base ?? tmpdir(),
    selfPid: options.selfPid ?? process.pid,
    uid: options.uid ?? process.getuid?.() ?? -1,
    maxRoots: options.maxRoots ?? STALE_ROOT_MAX_PER_START,
    budgetMs: options.budgetMs ?? STALE_ROOT_BUDGET_MS,
    kill: options.kill ?? ((pid, signal) => { process.kill(pid, signal); }),
    now: options.now ?? (() => Date.now()),
    random: options.random ?? Math.random,
    report: options.report ?? debugReport,
  };
}

/** ESRCH 才算进程不存在；EPERM、成功和其它 error 都不确定，保守视为活着。 */
function liveness(pid: number, kill: KillProbe): "alive" | "gone" | "unknown" {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
}

function parseMarker(source: string, nonce: string, piPid: number): Identity {
  let value: unknown;
  try { value = JSON.parse(source) as unknown; } catch { return { reason: "marker-invalid" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "marker-invalid" };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== MARKER_KEYS) return { reason: "marker-invalid" };
  if (record.version !== 1) return { reason: "marker-version-unknown" };
  if (typeof record.hostNonce !== "string" || !NONCE.test(record.hostNonce)) return { reason: "marker-invalid" };
  for (const key of ["piPid", "supervisorPid", "generation"] as const) {
    const field = record[key];
    if (!Number.isSafeInteger(field) || (field as number) <= 0) return { reason: "marker-invalid" };
  }
  if (record.hostNonce !== nonce || record.piPid !== piPid) return { reason: "identity-mismatch" };
  return { marker: record as unknown as SupervisorMarkerV1 };
}

async function checkRecords(path: string, uid: number): Promise<StaleRootSkipReason | undefined> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) return "unknown-entry";
  if (info.uid !== uid) return "foreign-owner";
  if ((info.mode & 0o7777) !== DIRECTORY_MODE) return "mode-mismatch";
  const entries = await readdir(path);
  if (entries.length > RECORDS_MAX_ENTRIES) return "layout-too-large";
  for (const entry of entries) {
    if (!SEGMENT_NAME.test(entry) && !INDEX_NAME.test(entry)) return "unknown-entry";
    const file = await lstat(join(path, entry));
    if (file.isSymbolicLink() || !file.isFile()) return "unknown-entry";
    if (file.uid !== uid) return "foreign-owner";
    if ((file.mode & 0o7777) !== FILE_MODE) return "mode-mismatch";
  }
  return undefined;
}

/** 校验封闭 layout 并读出 marker。删除前会再跑一次，比较两次读到的身份。 */
async function readIdentity(path: string, options: ResolvedOptions, nonce: string, piPid: number): Promise<Identity> {
  const root = await lstat(path);
  if (root.isSymbolicLink() || !root.isDirectory()) return { reason: "not-a-directory" };
  if (root.uid !== options.uid) return { reason: "foreign-owner" };
  if ((root.mode & 0o7777) !== DIRECTORY_MODE) return { reason: "mode-mismatch" };
  const entries = await readdir(path);
  let hasMarker = false;
  let hasRecords = false;
  for (const entry of entries) {
    if (entry === MARKER_NAME) hasMarker = true;
    else if (entry === RECORDS_NAME) hasRecords = true;
    else return { reason: "unknown-entry" };
  }
  if (!hasMarker) return { reason: "marker-missing" };
  const markerPath = join(path, MARKER_NAME);
  const marker = await lstat(markerPath);
  if (marker.isSymbolicLink() || !marker.isFile()) return { reason: "unknown-entry" };
  if (marker.uid !== options.uid) return { reason: "foreign-owner" };
  if ((marker.mode & 0o7777) !== FILE_MODE) return { reason: "mode-mismatch" };
  if (marker.size > MARKER_MAX_BYTES) return { reason: "marker-invalid" };
  if (hasRecords) {
    const reason = await checkRecords(join(path, RECORDS_NAME), options.uid);
    if (reason) return { reason };
  }
  return parseMarker(await readFile(markerPath, "utf8"), nonce, piPid);
}

async function inspectRoot(name: string, options: ResolvedOptions): Promise<Outcome> {
  const match = ROOT_NAME.exec(name);
  if (!match) return { removed: false, reason: "name-mismatch" };
  const pidText = match[1] as string;
  const nonce = match[2] as string;
  const piPid = Number(pidText);
  if (!Number.isSafeInteger(piPid) || piPid <= 0 || String(piPid) !== pidText) return { removed: false, reason: "name-mismatch" };
  if (piPid === options.selfPid) return { removed: false, reason: "self-root" };

  const piState = liveness(piPid, options.kill);
  if (piState !== "gone") return { removed: false, reason: piState === "alive" ? "owner-alive" : "owner-unknown" };

  const path = join(options.base, name);
  const identity = await readIdentity(path, options, nonce, piPid);
  if ("reason" in identity) return { removed: false, reason: identity.reason };
  const marker = identity.marker;
  if (marker.supervisorPid === options.selfPid) return { removed: false, reason: "self-root" };

  const supervisorState = liveness(marker.supervisorPid, options.kill);
  if (supervisorState !== "gone") return { removed: false, reason: supervisorState === "alive" ? "owner-alive" : "owner-unknown" };
  const piRecheck = liveness(marker.piPid, options.kill);
  if (piRecheck !== "gone") return { removed: false, reason: piRecheck === "alive" ? "owner-alive" : "owner-unknown" };

  const again = await readIdentity(path, options, nonce, piPid);
  if ("reason" in again) return { removed: false, reason: again.reason };
  if (again.marker.hostNonce !== marker.hostNonce
    || again.marker.piPid !== marker.piPid
    || again.marker.supervisorPid !== marker.supervisorPid
    || again.marker.generation !== marker.generation) {
    return { removed: false, reason: "identity-changed" };
  }

  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    return { removed: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "vanished" : "remove-failed" };
  }
  return { removed: true };
}

function shuffle(names: string[], random: () => number): void {
  for (let index = names.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    const swap = names[index] as string;
    names[index] = names[target] as string;
    names[target] = swap;
  }
}

/** 跑一次有界的清理 pass。测试用它直接驱动；运行时通过 scheduleStaleRootCleanup 调用。 */
export async function scavengeStaleRoots(options: StaleRootCleanupOptions = {}): Promise<StaleRootCleanupSummaryV1> {
  const resolved = resolveOptions(options);
  const startedAt = resolved.now();
  const skipped: Record<StaleRootSkipReason, number> = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<StaleRootSkipReason, number>;
  let names: string[] = [];
  let scanFailed = false;
  try {
    names = (await readdir(resolved.base)).filter((name) => ROOT_NAME.test(name));
  } catch {
    scanFailed = true;
  }
  shuffle(names, resolved.random);
  let inspected = 0;
  let removed = 0;
  let deferred = 0;
  // 软预算只挡「开始下一个 root」；已经开始的 root 一定走完全部检查和删除，
  // 因此 durationMs 可能大于 budgetMs，这不算失败。
  for (let index = 0; index < names.length; index++) {
    if (inspected >= resolved.maxRoots || resolved.now() - startedAt >= resolved.budgetMs) {
      deferred = names.length - index;
      break;
    }
    inspected += 1;
    try {
      const outcome = await inspectRoot(names[index] as string, resolved);
      if (outcome.removed) removed += 1;
      else skipped[outcome.reason] += 1;
    } catch (error) {
      skipped[(error as NodeJS.ErrnoException).code === "ENOENT" ? "vanished" : "inspect-failed"] += 1;
    }
  }
  const summary: StaleRootCleanupSummaryV1 = {
    version: 1,
    base: resolved.base,
    scanned: names.length,
    inspected,
    removed,
    deferred,
    durationMs: resolved.now() - startedAt,
    scanFailed,
    skipped,
  };
  resolved.report(summary);
  return summary;
}

let scheduled = false;

/**
 * 每个 Pi process 只安排一次，且不阻塞 session_start：readdir 和逐个检查都在 setImmediate 之后跑。
 * 唯一调用者是 Main extension 的 session_start（src/index.ts）；child runtime 不做清理。
 */
export function scheduleStaleRootCleanup(options: StaleRootCleanupOptions = {}): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => { void scavengeStaleRoots(options).catch(() => undefined); });
}
