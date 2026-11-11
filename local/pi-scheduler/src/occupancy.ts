/**
 * Session-occupancy registry (decision #17). The extension registers
 * {sessionId, pid, holderToken} on session_start and unregisters on shutdown;
 * the daemon trusts this registry to decide whether a session-target task may
 * run now, or whether its unique live holder may receive an injection.
 *
 * Pi does not lock session files, so this registry is the source of truth. A
 * pid-liveness check is the crash fallback: a registration whose process is
 * gone is pruned. Persisted entries without a holder token remain occupied for
 * compatibility, but are never eligible to receive an injection.
 */

export type PidLiveness = (pid: number) => boolean;

export interface OccupancyEntry {
  sessionId: string;
  pid: number;
  holderToken?: string;
  bindingGen?: number;
}

export interface UniqueHolder {
  sessionId: string;
  pid: number;
  holderToken: string;
  bindingGen: number;
}

export type HolderRejection = "no-holder" | "multiple-live-holders" | "legacy-holder" |
  "pid-mismatch" | "token-mismatch" | "generation-mismatch";

export interface OccupancyRegistryOptions {
  alive?: PidLiveness;
  /** Entries restored from disk on daemon start (decision #13 across restarts). */
  initial?: readonly OccupancyEntry[];
  /** Called whenever the live set changes, so the daemon can persist it. */
  onChange?: (entries: OccupancyEntry[]) => void;
}

/** Default liveness probe: signal 0 tells us if the pid exists. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = gone; EPERM = alive but not ours (still occupied).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LEGACY = Symbol("legacy occupancy holder");
type TokenHolder = { holderToken: string; bindingGen: number };
type Holder = TokenHolder | typeof LEGACY;
type Entry = OccupancyEntry;

export class OccupancyRegistry {
  /** sessionId → pid → token, or LEGACY for old persisted registrations. */
  private readonly holders = new Map<string, Map<number, Holder>>();
  private readonly alive: PidLiveness;
  private readonly onChange?: (entries: OccupancyEntry[]) => void;

  constructor(options: OccupancyRegistryOptions | PidLiveness = {}) {
    // Back-compat: a bare liveness function is still accepted.
    const opts: OccupancyRegistryOptions = typeof options === "function"
      ? { alive: options }
      : options;
    this.alive = opts.alive ?? processAlive;
    this.onChange = opts.onChange;
    // Restore persisted holders, dropping any whose process is already gone so
    // a daemon restart never treats a dead holder as occupying a session.
    let pruned = false;
    for (const entry of opts.initial ?? []) {
      if (this.alive(entry.pid)) {
        this.set(
          entry.sessionId,
          entry.pid,
          typeof entry.holderToken === "string"
            ? { holderToken: entry.holderToken, bindingGen: Math.max(0, entry.bindingGen ?? 0) }
            : LEGACY,
        );
      } else {
        pruned = true;
      }
    }
    if (pruned) this.onChange?.(this.snapshot());
  }

  private set(sessionId: string, pid: number, holder: Holder): { status: "applied" | "current" | "stale"; currentGeneration?: number } {
    let holders = this.holders.get(sessionId);
    if (!holders) this.holders.set(sessionId, holders = new Map());
    const current = holders.get(pid);
    if (current === LEGACY && holder === LEGACY) return { status: "current" };
    if (current !== undefined && current !== LEGACY && holder !== LEGACY) {
      // A late register from an older binding must not replace a newer holder.
      if (holder.bindingGen < current.bindingGen) return { status: "stale", currentGeneration: current.bindingGen };
      // Same generation is an exact identity check, never an arrival-order
      // tiebreaker: two reloads must not replace one another accidentally.
      if (holder.bindingGen === current.bindingGen) {
        return holder.holderToken === current.holderToken
          ? { status: "current", currentGeneration: current.bindingGen }
          : { status: "stale", currentGeneration: current.bindingGen };
      }
    }
    holders.set(pid, holder);
    return { status: "applied", ...(holder === LEGACY ? {} : { currentGeneration: holder.bindingGen }) };
  }

  /** Register one binding and report the daemon generation on stale migration. */
  register(sessionId: string, pid: number, holderToken?: string, bindingGen?: number): { accepted: boolean; currentGeneration?: number } {
    const holder = holderToken === undefined
      ? LEGACY
      : { holderToken, bindingGen: Math.max(0, bindingGen ?? 0) };
    const result = this.set(sessionId, pid, holder);
    if (result.status === "applied") this.onChange?.(this.snapshot());
    return { accepted: result.status !== "stale", ...(result.currentGeneration === undefined ? {} : { currentGeneration: result.currentGeneration }) };
  }

  unregister(sessionId: string, pid: number, holderToken?: string, bindingGen?: number): void {
    const holders = this.holders.get(sessionId);
    const current = holders?.get(pid);
    if (!holders || current === undefined) return;
    // A tokenful registration can only be released by its exact binding. Old
    // tokenless registrations retain historical pid-only semantics.
    if (current !== LEGACY && (
      current.holderToken !== holderToken || current.bindingGen !== Math.max(0, bindingGen ?? 0)
    )) return;
    holders.delete(pid);
    if (holders.size === 0) this.holders.delete(sessionId);
    this.onChange?.(this.snapshot());
  }

  /** Prune dead pids for one session and persist the changed live set. */
  private prune(sessionId: string): Map<number, Holder> | undefined {
    const holders = this.holders.get(sessionId);
    if (!holders) return undefined;
    let changed = false;
    for (const pid of holders.keys()) {
      if (!this.alive(pid)) {
        holders.delete(pid);
        changed = true;
      }
    }
    if (holders.size === 0) this.holders.delete(sessionId);
    if (changed) this.onChange?.(this.snapshot());
    return this.holders.get(sessionId);
  }

  /** Is the session held by any live Pi right now? */
  isOccupied(sessionId: string): boolean {
    return (this.prune(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Return the sole live holder only when it has a binding token. Multiple
   * holders, or a sole legacy holder, fail closed and cannot receive injection.
   */
  getUniqueHolder(sessionId: string): UniqueHolder | undefined {
    const holders = this.prune(sessionId);
    if (!holders || holders.size !== 1) return undefined;
    const [pid, holder] = holders.entries().next().value as [number, Holder];
    if (holder === LEGACY) return undefined;
    return { sessionId, pid, holderToken: holder.holderToken, bindingGen: holder.bindingGen };
  }

  /** Exact injection authorization, with a reason from the same pruned live set. */
  checkHolder(identity: UniqueHolder): { ok: true; holder: UniqueHolder } | { ok: false; reason: HolderRejection } {
    const holders = this.prune(identity.sessionId);
    if (!holders?.size) return { ok: false, reason: "no-holder" };
    if (holders.size !== 1) return { ok: false, reason: "multiple-live-holders" };
    const [pid, holder] = holders.entries().next().value as [number, Holder];
    if (holder === LEGACY) return { ok: false, reason: "legacy-holder" };
    if (pid !== identity.pid) return { ok: false, reason: "pid-mismatch" };
    if (holder.holderToken !== identity.holderToken) return { ok: false, reason: "token-mismatch" };
    if (holder.bindingGen !== identity.bindingGen) return { ok: false, reason: "generation-mismatch" };
    return { ok: true, holder: { sessionId: identity.sessionId, pid, ...holder } };
  }

  /** Snapshot for diagnostics and persistence. */
  snapshot(): Entry[] {
    const out: Entry[] = [];
    for (const [sessionId, holders] of this.holders) {
      for (const [pid, holder] of holders) {
        out.push({ sessionId, pid, ...(holder === LEGACY ? {} : holder) });
      }
    }
    return out;
  }
}
