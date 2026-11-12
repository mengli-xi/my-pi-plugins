/**
 * Explicit process-wide handoff for resources Pi does not dispose on /reload.
 * The record owns no session context; it only gives the next factory a way to
 * synchronously stop the previous instance's timers and observers.
 */
export const PERF_RUNTIME_KEY = Symbol.for("pi.perf.runtime-owner.v1");

interface PerfRuntimeOwnerV1 {
  version: 1;
  token: object;
  retire(): void;
}

export interface PerfRuntimeOwnership {
  replaced: boolean;
  release(): void;
}

export function acquirePerfRuntimeOwnership(retire: () => void): PerfRuntimeOwnership {
  const host = globalThis as Record<PropertyKey, unknown>;
  const previous = host[PERF_RUNTIME_KEY] as Partial<PerfRuntimeOwnerV1> | undefined;
  const replaced = previous?.version === 1 && typeof previous.retire === "function";
  if (replaced) {
    try { previous.retire!(); } catch {}
  }

  const token = {};
  const owner: PerfRuntimeOwnerV1 = { version: 1, token, retire };
  host[PERF_RUNTIME_KEY] = owner;
  let active = true;
  return {
    replaced,
    release() {
      if (!active) return;
      active = false;
      const current = host[PERF_RUNTIME_KEY] as Partial<PerfRuntimeOwnerV1> | undefined;
      if (current?.version === 1 && current.token === token) {
        Reflect.deleteProperty(host, PERF_RUNTIME_KEY);
      }
    },
  };
}
