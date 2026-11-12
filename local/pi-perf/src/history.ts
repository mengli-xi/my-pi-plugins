import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setImmediate as yieldToUi } from "node:timers/promises";
import { join } from "node:path";
import { addValue, emptyHistogram } from "./histogram.ts";
import { DAY_MS, InvalidDailyFile, mergeShard, readShard, summaries, type DailyShard, type HistoryRecord, type Identity,
  packageHash, type RuntimeSample, type StartupSample, type TrendResult } from "./daily-format.ts";
import { withStorageLock } from "./storage-lock.ts";
export * from "./daily-format.ts";

export const IDENTITY_TIMEOUT_MS = 120_000;
export const RUN_RETENTION_DAYS = 7;
export const TMP_SCAN_DAYS = 3;
export const MAX_TREND_FILES = 512;
const date = (at: number) => new Date(at).toISOString().slice(0, 10);
const METRICS = new Set(["rss", "heapUsed", "heapTotal", "external", "cpuPercent", "loopP50Ms", "loopP99Ms", "loopMaxMs",
  "entries", "contextTokens", "readyMs", "extensionReachedMs", "extensionToReadyMs", "firstObservedFrameMs", "launcherFirstObservedFrameMs"]);
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface MaintenanceState { errorCount: number; failedDays: Record<string, string> }
function maintenanceMessage(state: MaintenanceState): string | undefined {
  if (!state.errorCount) return undefined;
  return `maintenance: ${state.errorCount} historical errors; ` + Object.entries(state.failedDays).sort().slice(-10).map(([day, reason]) => `${day}: ${reason}`).join("; ");
}

/** Writers only publish loose shards. Only the maintenance owner merges archives. */
export class PerfHistory {
  readonly run = randomUUID();
  error?: string;
  maintenanceError?: string;
  private pending: Promise<void> = Promise.resolve();
  identityError?: string;
  private readonly identityReady: Promise<void>;
  private resolveIdentity!: () => void;
  private identityTimer?: NodeJS.Timeout;
  private shard?: DailyShard;
  readonly root: string;
  readonly identity: Identity;
  constructor(root: string, identity: Identity) {
    this.root = root; this.identity = identity;
    this.identityReady = new Promise(resolve => { this.resolveIdentity = resolve; });
    this.identityTimer = setTimeout(() => this.fallbackIdentity("identity timed out; using local"), IDENTITY_TIMEOUT_MS);
    this.identityTimer.unref();
  }
  private finishIdentity(): void { clearTimeout(this.identityTimer); this.identityTimer = undefined; this.resolveIdentity(); }
  private fallbackIdentity(reason: string): void {
    this.identity.packages = ["local"]; this.identity.packagesHash = packageHash(this.identity.packages);
    this.identityError = reason; this.finishIdentity();
  }
  setIdentityReady(ready: Promise<void>): void {
    void ready.then(() => { this.identityError = undefined; this.finishIdentity(); }, () => this.fallbackIdentity("identity resolution failed; using local"));
  }
  write(kind: HistoryRecord["kind"], values: RuntimeSample | StartupSample | Record<string, number>, at = Date.now()): void {
    const safeValues = Object.fromEntries(Object.entries(values).filter(([key, value]) => METRICS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0));
    // Startup records wait only in this asynchronous output queue, not in the
    // session_start handler. All their package fields are filled after parsing.
    this.pending = this.pending.then(async () => {
      await this.identityReady;
      const record: HistoryRecord = { ...this.identity, packages: [...this.identity.packages], at, run: this.run, kind, values: safeValues };
      await this.append(record); this.error = undefined;
    }).catch(error => { this.error = `history write failed: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`; });
  }
  async flush(): Promise<void> { await this.pending; }
  private async append(record: HistoryRecord): Promise<void> {
    const day = date(record.at);
    await mkdir(join(this.root, "raw"), { recursive: true, mode: 0o700 });
    const payload = Buffer.from(JSON.stringify(record) + "\n");
    if (payload.length > 65536) throw new Error("history record exceeds 64KiB");
    const file = await open(join(this.root, "raw", `${day}.jsonl`), "a", 0o600);
    try {
      const { bytesWritten } = await file.write(payload);
      if (bytesWritten !== payload.length) throw new Error("short append; raw log may have an incomplete tail");
    } finally { await file.close(); }
    const directory = join(this.root, "daily", day);
    const late = day < date(Date.now() - RUN_RETENTION_DAYS * DAY_MS);
    const path = join(directory, `${late ? randomUUID() : this.run}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const currentIdentity: Identity = { pid: record.pid, piVersion: record.piVersion, packagesHash: record.packagesHash,
      packages: record.packages, mode: record.mode, packageResolveMs: record.packageResolveMs };
    // Late records are immutable, unique deltas: compaction can move a snapshot
    // without a writer recreating an already-archived cached total.
    if (late) this.shard = undefined;
    if (late || this.shard?.day !== day) {
      try { this.shard = late ? undefined : await readShard(path, day); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof InvalidDailyFile)) throw error;
        // Corrupt or oversized OWN files are recoverable; other runs remain untouched.
        this.shard = undefined;
      }
      if (!this.shard) this.shard = { version: 2, day, identity: currentIdentity, sessions: 0, startups: 0, histograms: {} };
    }
    const shard = this.shard!;
    shard.identity = currentIdentity;
    if (record.kind === "session") shard.sessions++;
    if (record.kind === "startup" && record.values.readyMs !== undefined) shard.startups++;
    for (const [key, value] of Object.entries(record.values)) addValue(shard.histograms[key] ??= emptyHistogram(), value);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(shard), { mode: 0o600 });
    await rename(temporary, path);
  }
  /** No maintenance I/O at extension evaluation or session_start. Subprocesses
   * that exit within 30s never run it; long processes retry every six hours. */
  scheduleCleanup(): () => void {
    const controller = new AbortController(); let timer: NodeJS.Timeout;
    const run = async () => {
      await this.cleanup(Date.now(), controller.signal);
      if (!controller.signal.aborted) { timer = setTimeout(run, 6 * 60 * 60_000); timer.unref(); }
    };
    timer = setTimeout(run, 30_000); timer.unref();
    return () => { controller.abort(); clearTimeout(timer); };
  }
  private async readMaintenanceState(): Promise<MaintenanceState> {
    try {
      const value = JSON.parse(await readFile(join(this.root, ".maintenance/state.json"), "utf8")) ?? {};
      return { errorCount: Number.isSafeInteger(value.errorCount) && value.errorCount >= 0 ? value.errorCount : 0,
        failedDays: Object.fromEntries(Object.entries(value.failedDays ?? {}).filter(([day, reason]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && typeof reason === "string")) as Record<string, string> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { errorCount: 0, failedDays: {} };
      throw error;
    }
  }
  async loadMaintenanceErrors(): Promise<void> {
    try { this.maintenanceError = maintenanceMessage(await this.readMaintenanceState()) ?? this.maintenanceError; }
    catch (error) { this.maintenanceError = `maintenance state unavailable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`; }
  }
  async cleanup(now = Date.now(), signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const maintenance = join(this.root, ".maintenance");
    try {
      await mkdir(maintenance, { recursive: true, mode: 0o700 });
      await withStorageLock(maintenance, async assertOwned => {
        const statePath = join(maintenance, "state.json");
        let state = await this.readMaintenanceState();
        const entries = async (directory: string) => {
          try { return await opendir(directory); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        };
        const saveState = async () => {
          const temporary = `${statePath}.${process.pid}.tmp`;
          assertOwned(); await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
          assertOwned(); await rename(temporary, statePath);
        };
        await chmod(this.root, 0o700);
        if (await exists(join(this.root, "ui.jsonl"))) await chmod(join(this.root, "ui.jsonl"), 0o600);
        const reports = await entries(join(this.root, "reports"));
        if (reports) {
          await chmod(join(this.root, "reports"), 0o700);
          for await (const entry of reports) if (entry.isFile() && entry.name.endsWith(".html")) await chmod(join(this.root, "reports", entry.name), 0o600);
        }
        const raw = await entries(join(this.root, "raw"));
        if (raw) for await (const entry of raw) {
          if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name) && entry.name.slice(0, 10) < date(now - 90 * DAY_MS)) await rm(join(this.root, "raw", entry.name), { force: true });
        }
        // Deterministic recent date paths, NOT a traversal of all daily runs.
        const tmpDirectories = [this.root, maintenance, join(this.root, "raw"), join(this.root, "reports"),
          ...Array.from({ length: TMP_SCAN_DAYS }, (_, age) => join(this.root, "daily", date(now - age * DAY_MS)))];
        const { cleanDeadTemps, compactDay, needsCompaction } = await import("./daily-archive.ts");
        for (const directory of tmpDirectories) {
          if (signal?.aborted) return;
          await cleanDeadTemps(directory, now);
        }
        const daily = await entries(join(this.root, "daily")); const dates: string[] = [];
        if (daily) for await (const entry of daily) {
          if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < date(now - RUN_RETENTION_DAYS * DAY_MS)
            && (state.failedDays[entry.name] !== undefined || await needsCompaction(join(this.root, "daily", entry.name)))) dates.push(entry.name);
        }
        const before = JSON.stringify(state);
        for (const day of dates.sort()) {
          if (signal?.aborted) return;
          const directory = join(this.root, "daily", day);
          try {
            await withStorageLock(directory, async owned => {
              const invalid = await compactDay(directory, day, owned, signal);
              if (invalid) throw new Error(`retained ${invalid} invalid run files for manual recovery`);
            });
            delete state.failedDays[day];
          } catch (error) {
            state.failedDays[day] = (error as NodeJS.ErrnoException).code ?? (error instanceof SyntaxError ? "invalid JSON" : (error as Error).message);
          }
          // 计数只反映仍未解决的日期，合并成功后警告随之消失
          state.errorCount = Object.keys(state.failedDays).length;
          if (signal?.aborted) return;
          await yieldToUi();
        }
        if (JSON.stringify(state) !== before) await saveState();
        this.maintenanceError = maintenanceMessage(state);
      }, true);
    } catch (error) { this.maintenanceError = `maintenance failed: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`; }
  }
  async trends(days: 7 | 30, now = Date.now()): Promise<TrendResult> {
    await this.flush();
    const groups = new Map<string, DailyShard>();
    let skippedFiles = 0, readFiles = 0, combinedGroups = false, busyDays = 0, limited = false;
    const { readArchive } = await import("./daily-archive.ts");
    for (let age = 0; age < days && !limited; age++) {
      const day = date(now - age * DAY_MS), directory = join(this.root, "daily", day);
      try { if (!await exists(directory)) continue; } catch { skippedFiles++; continue; }
      let entered = false;
      try {
        const readDay = async (assertOwned: () => void) => {
          entered = true;
          // A crashed transaction is recovered by maintenance / the next writer,
          // not silently read halfway through an archive publication.
          if (await exists(join(directory, ".compact"))) { busyDays++; return; }
          if (await exists(join(directory, "summary.jsonl"))) {
            if (readFiles >= MAX_TREND_FILES) { limited = true; return; }
            readFiles++;
            try {
              const archive = await readArchive(directory, day); assertOwned(); combinedGroups ||= archive.combined;
              for (const shard of archive.groups.values()) mergeShard(groups, shard);
            } catch { skippedFiles++; }
          }
          const files = await opendir(directory);
          for await (const entry of files) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            if (readFiles >= MAX_TREND_FILES) { limited = true; return; }
            readFiles++;
            try { const shard = await readShard(join(directory, entry.name), day); assertOwned(); mergeShard(groups, shard); } catch { skippedFiles++; }
            await yieldToUi();
          }
        };
        if (day < date(Date.now() - RUN_RETENTION_DAYS * DAY_MS) || await exists(join(directory, "summary.jsonl"))) await withStorageLock(directory, readDay, true);
        else await readDay(() => {});
        if (!entered) busyDays++;
      } catch { skippedFiles++; }
    }
    return { rows: summaries(groups), skippedFiles, limited, combinedGroups, busyDays };
  }
}

export function trendText(rows: import("./daily-format.ts").DailySummary[], skippedFiles = 0, limited = false, combinedGroups = false, busyDays = 0): string {
  const metric = (row: import("./daily-format.ts").DailySummary, key: string, divisor = 1) => {
    const value = row.metrics[key];
    return value ? `${(value.p50 / divisor).toFixed(1)}/${(value.p95 / divisor).toFixed(1)}/${(value.max / divisor).toFixed(1)}` : "—";
  };
  return [...(skippedFiles ? [`警告：跳过 ${skippedFiles} 个损坏、不可读或超限的 daily 文件，趋势不完整。`] : []),
    ...(busyDays ? [`警告：跳过 ${busyDays} 个正在维护或写入的日期，趋势不完整。`] : []),
    ...(limited ? [`警告：达到 ${MAX_TREND_FILES} 个文件的读取上限，趋势不完整。`] : []),
    ...(combinedGroups ? ["旧日组合过多，部分组合按模式合并为 mixed / other。"] : []),
    "日期 · Pi · 模式 · 插件组合（哈希） · 会话 · 冷启动ms · RSS MiB · CPU% · loop p99 ms (≈p50/p95/max)",
    ...rows.map(row => `${row.day} · ${row.piVersion} · ${row.mode} · ${row.packages.join(", ") || "未知/无包"} (${row.packagesHash}) · ${row.sessions} · ${metric(row, "readyMs")} · ${metric(row, "rss", 1048576)} · ${metric(row, "cpuPercent")} · ${metric(row, "loopP99Ms")}`)
  ].join("\n");
}
