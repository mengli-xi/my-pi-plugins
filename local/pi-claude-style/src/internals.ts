/**
 * Drift detection for the pi internals this package patches.
 *
 * Several features here work by wrapping pi's own prototypes — a compact
 * custom-message row, folded native tool output, the pinned layout. That buys
 * behaviour no public API offers, at the price of depending on names pi never
 * promised: `CustomMessageComponent.prototype.rebuild`, `this.chatContainer`,
 * `Text`'s own `text` field.
 *
 * The danger is not that those names move. It is that they move *quietly*:
 * every patch site already guards itself, either with `typeof x === "function"`
 * before installing or with a `catch` that keeps pi's rendering. Both are
 * correct — a broken patch must never take the session down — and both leave
 * the user with silently degraded output and no idea why.
 *
 * So each patch declares what it depends on, and the outcome is recorded:
 *
 * - **Prototype names** are checked eagerly, before anything is installed.
 *   `npm run check-internals` runs exactly these against the installed pi and
 *   needs no session, so a pi upgrade can be cleared in one command.
 * - **Instance fields** cannot be seen without a live instance, so the patch
 *   body reports its own first outcome through `markOk` / `markBroken`.
 *
 * A probe that has never reported is `unexercised`, which is deliberately not
 * the same as healthy: after an upgrade, "the custom-message patch never ran"
 * is exactly as interesting as "it ran and threw".
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./config/agent-dir.ts";

/**
 * pi's own version — what every recorded state is keyed to.
 *
 * Every entry point takes it as an argument defaulting to this, so a test can
 * drive a version change without reinstalling pi.
 */
function piVersion(): string {
  return VERSION || "unknown";
}

export type ProbeState = "ok" | "missing" | "broken" | "unexercised";

export interface Probe {
  /** Stable key, `<patch>.<name>`. Survives across versions; never reuse one. */
  id: string;
  /** The internal being depended on, written the way you would grep for it. */
  needs: string;
  /** What the user loses when it goes. One line, in the report. */
  breaks: string;
  /**
   * Eager existence check. Prototype-level probes have one; instance-level
   * probes do not, and report through `markOk` / `markBroken` instead.
   *
   * Must not throw — a probe that explodes is itself a drift signal, so it is
   * caught and recorded as `missing`.
   */
  check?: () => boolean;
}

export interface ProbeRow extends Probe {
  state: ProbeState;
  detail?: string;
}

interface StoredState {
  state: ProbeState;
  detail?: string;
}

interface Health {
  version: string;
  probes: Record<string, StoredState>;
  /** Fingerprints already put in front of the user, so a report shows once. */
  reported: string[];
}

interface Registry {
  probes: Map<string, Probe>;
  health: Health | undefined;
  path: string;
  pendingWrite?: { path: string; contents: string };
  writePromise?: Promise<void>;
}

/**
 * Shared through a well-known symbol rather than an import.
 *
 * The forked packages patch pi too (`ExtensionRunner.prototype`,
 * `UserMessageComponent.prototype`), and should be able to declare that
 * without taking a dependency on this package — a fork carrying an extra
 * `file:` edge is one more thing an upstream merge can trip over.
 */
const REGISTRY_KEY = Symbol.for("pi.claude-style.internals.v1");

export const HEALTH_PATH = join(
  getAgentDir(),
  "extensions",
  "pi-claude-transcript",
  "internals-health.json",
);

function registry(): Registry {
  const host = globalThis as Record<PropertyKey, unknown>;
  let existing = host[REGISTRY_KEY] as Registry | undefined;
  if (!existing) {
    existing = { probes: new Map(), health: undefined, path: HEALTH_PATH };
    host[REGISTRY_KEY] = existing;
  }
  return existing;
}

/** Point the store somewhere else. Tests only. */
export function setHealthPath(path: string): void {
  const reg = registry();
  reg.path = path;
  reg.health = undefined;
}

function emptyHealth(version: string): Health {
  return { version, probes: {}, reported: [] };
}

/**
 * The stored state, reset whenever pi's version moved.
 *
 * A recorded `ok` says "this name was there in 0.83.0", which is worth nothing
 * once 0.84.0 is installed. Dropping the whole file on a version change is
 * both the correct invalidation and the reason an upgrade re-reports.
 */
function load(version: string): Health {
  const reg = registry();
  if (reg.health && reg.health.version === version) return reg.health;
  let health = emptyHealth(version);
  try {
    const parsed = JSON.parse(readFileSync(reg.path, "utf8")) as Partial<Health>;
    if (
      parsed && parsed.version === version && typeof parsed.probes === "object" &&
      parsed.probes !== null
    ) {
      health = {
        version,
        probes: parsed.probes as Record<string, StoredState>,
        reported: Array.isArray(parsed.reported) ? parsed.reported : [],
      };
    }
  } catch {
    // No file, unreadable, or written by another version: start clean.
  }
  reg.health = health;
  return health;
}

function startHealthWrite(reg: Registry): void {
  if (reg.writePromise) return;
  reg.writePromise = Promise.resolve().then(async () => {
    while (reg.pendingWrite) {
      const pending = reg.pendingWrite;
      reg.pendingWrite = undefined;
      try {
        await mkdir(dirname(pending.path), { recursive: true });
        const temporary = `${pending.path}.${process.pid}.tmp`;
        await writeFile(temporary, pending.contents);
        await rename(temporary, pending.path);
      } catch {
        // Health tracking must never be the thing that breaks a session.
      }
    }
  }).finally(() => {
    reg.writePromise = undefined;
    // A save can land between the loop's last check and finally. Re-arm it.
    if (reg.pendingWrite) startHealthWrite(reg);
  });
}

function save(health: Health): void {
  const reg = registry();
  reg.pendingWrite = {
    path: reg.path,
    contents: `${JSON.stringify(health, null, 2)}\n`,
  };
  startHealthWrite(reg);
}

/** Test/shutdown boundary for the buffered health writer. */
export async function flushInternalsHealth(): Promise<void> {
  const reg = registry();
  while (reg.writePromise) await reg.writePromise;
}

/** Register what a patch depends on. Idempotent: a re-declared id wins. */
export function declareProbes(probes: readonly Probe[]): void {
  const known = registry().probes;
  for (const probe of probes) known.set(probe.id, probe);
}

export function declaredProbes(): Probe[] {
  return [...registry().probes.values()];
}

/** Forget every declaration and cached state. Tests only. */
export function resetInternals(): void {
  const host = globalThis as Record<PropertyKey, unknown>;
  delete host[REGISTRY_KEY];
}

function record(id: string, next: StoredState, version: string): void {
  const health = load(version);
  const previous = health.probes[id];
  if (previous?.state === next.state && previous.detail === next.detail) return;
  health.probes[id] = next;
  save(health);
}

/**
 * The patch ran and found what it expected.
 *
 * Called from hot paths — every custom message, every rendered row — so it
 * short-circuits on an unchanged state. A transition updates memory now and
 * enters the coalesced asynchronous writer; render/input never performs the
 * mkdir/write/rename itself.
 */
export function markOk(id: string, version: string = piVersion()): void {
  record(id, { state: "ok" }, version);
}

/** The patch ran and did not find what it expected. `detail` reaches the report. */
export function markBroken(
  id: string,
  detail: string,
  version: string = piVersion(),
): void {
  record(id, { state: "broken", detail }, version);
}

/**
 * Run every eager check and fold in what the runtime has reported.
 *
 * Eager results are authoritative for the probes that have one: a name that is
 * gone right now is `missing` regardless of what some earlier session managed
 * to do with it.
 */
export function auditInternals(version: string = piVersion()): ProbeRow[] {
  const health = load(version);
  return declaredProbes().map((probe) => {
    if (probe.check) {
      let present: boolean;
      let detail: string | undefined;
      try {
        present = probe.check();
      } catch (error) {
        present = false;
        detail = error instanceof Error ? error.message : String(error);
      }
      if (!present) return { ...probe, state: "missing" as const, detail };
    }
    const stored = health.probes[probe.id];
    if (!stored) {
      return {
        ...probe,
        state: probe.check ? ("ok" as const) : ("unexercised" as const),
      };
    }
    return { ...probe, state: stored.state, detail: stored.detail };
  });
}

export function isHealthy(row: ProbeRow): boolean {
  return row.state === "ok";
}

/**
 * A stable identity for "this exact set of problems, on this exact version".
 *
 * The report is keyed to it so a still-broken patch stays quiet on the next
 * session, while a *newly* broken one speaks up immediately.
 */
export function driftFingerprint(rows: ProbeRow[], version: string): string {
  const broken = rows
    .filter((row) => row.state === "missing" || row.state === "broken")
    .map((row) => `${row.id}:${row.state}`)
    .sort();
  return `${version}|${broken.join(",")}`;
}

export function wasReported(fingerprint: string, version: string = piVersion()): boolean {
  return load(version).reported.includes(fingerprint);
}

export function markReported(fingerprint: string, version: string = piVersion()): void {
  const health = load(version);
  if (health.reported.includes(fingerprint)) return;
  health.reported.push(fingerprint);
  save(health);
}

/**
 * Drift worth putting in front of the user right now, or undefined.
 *
 * Polled from safe moments (session start, agent end) rather than pushed from
 * `markBroken`: that is called from inside render paths, and sending a message
 * from there would re-enter the renderer mid-frame.
 *
 * Only `missing` and `broken` qualify. `unexercised` is the expected state for
 * every probe in the first session after an upgrade — reporting it there would
 * fire a full-width warning that says nothing except "you just upgraded", and
 * the next real one would get skimmed past. It surfaces in `/internals` and in
 * `npm run check-internals`, both of which are asked rather than pushed.
 */
export function consumeNewDrift(
  version: string = piVersion(),
): { rows: ProbeRow[]; fingerprint: string } | undefined {
  const rows = auditInternals(version);
  const bad = rows.filter((row) => row.state === "missing" || row.state === "broken");
  if (bad.length === 0) return undefined;
  const fingerprint = driftFingerprint(rows, version);
  if (wasReported(fingerprint, version)) return undefined;
  markReported(fingerprint, version);
  return { rows, fingerprint };
}

/** pi's version, for callers that want to label a report with it. */
export function currentPiVersion(): string {
  return piVersion();
}

const STATE_LABEL: Record<ProbeState, string> = {
  ok: "ok",
  missing: "缺失",
  broken: "调用失败",
  unexercised: "未触发",
};

/** The one-line transcript row. */
export function summariseDrift(rows: ProbeRow[], version: string): string {
  const bad = rows.filter((row) => row.state === "missing" || row.state === "broken");
  const idle = rows.filter((row) => row.state === "unexercised");
  const parts = [`pi ${version}`];
  if (bad.length > 0) parts.push(`${bad.length} 处内部依赖失效`);
  if (idle.length > 0) parts.push(`${idle.length} 处未触发`);
  if (bad.length === 0 && idle.length === 0) parts.push(`${rows.length} 处内部依赖正常`);
  return parts.join(" · ");
}

/** The popup body. Plain text: it is a report, not prose. */
export function renderDriftReport(rows: ProbeRow[], version: string): string {
  const order: ProbeState[] = ["missing", "broken", "unexercised", "ok"];
  const lines = [`pi ${version} · ${rows.length} 处内部依赖`, ""];
  for (const state of order) {
    const group = rows.filter((row) => row.state === state);
    if (group.length === 0) continue;
    lines.push(`${STATE_LABEL[state]} (${group.length})`);
    for (const row of group) {
      lines.push(`  ${row.id}`);
      lines.push(`    依赖  ${row.needs}`);
      if (state !== "ok") lines.push(`    影响  ${row.breaks}`);
      if (row.detail) lines.push(`    详情  ${row.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
