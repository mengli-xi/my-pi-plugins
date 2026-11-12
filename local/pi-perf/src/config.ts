import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Node timers accept 1..2^31-1 ms; outside that range they silently become 1ms. */
export function sampleInterval(raw: string | undefined, fallback = 60_000): number {
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 2_147_483_647 ? value : fallback;
}

/** Thresholds are not timers: zero means record every sample. */
export function sampleThreshold(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 2_147_483_647 ? value : fallback;
}

export class PerfConfig {
  readonly path: string;
  error?: string;
  private raw: string | undefined;
  private stored: Record<string, unknown> = { schemaVersion: 1, revision: 0, overrides: {} };
  constructor(agentDir: string) {
    this.path = join(agentDir, "extensions/pi-perf/config.json");
    try {
      this.raw = readFileSync(this.path, "utf8");
      const value = JSON.parse(this.raw);
      if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !value.overrides || typeof value.overrides !== "object" || Array.isArray(value.overrides) ||
        (value.overrides.enabled !== undefined && typeof value.overrides.enabled !== "boolean")) throw new Error("invalid schema");
      this.stored = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = `config unavailable: ${(error as Error).name}`;
    }
  }
  get enabled(): boolean { return !this.error && (this.stored.overrides as { enabled?: boolean }).enabled !== false; }
  setEnabled(enabled: boolean): void {
    if (this.error) throw new Error(this.error);
    let disk: string | undefined;
    try { disk = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (disk !== this.raw) throw new Error("config changed in another process; restart before editing");
    const next = { ...this.stored, revision: (this.stored.revision as number) + 1,
      overrides: { ...(this.stored.overrides as object), enabled } };
    const raw = JSON.stringify(next, null, 2) + "\n";
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, raw, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.stored = next;
    this.raw = raw;
  }
}
