import { VERSION } from "@earendil-works/pi-coding-agent";

export interface Probe {
  id: string;
  needs: string;
  breaks: string;
  check(): boolean;
}

export interface ProbeRegistry {
  probes: Map<string, Probe>;
  health?: { version: string; probes: Record<string, { state: string; detail?: string }> };
}

export function markOk(id: string): void { const health = registry()?.health; if (health) health.probes[id] = { state: "ok" }; }
export function markBroken(id: string, detail: string): void { const health = registry()?.health; if (health) health.probes[id] = { state: "broken", detail }; }

const REGISTRY_KEY = Symbol.for("pi.claude-style.internals.v1");

function registry(): ProbeRegistry | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY] as ProbeRegistry | undefined;
}

export function declareProbes(probes: readonly Probe[]): void {
  const shared = registry();
  if (shared?.probes instanceof Map) {
    for (const probe of probes) shared.probes.set(probe.id, probe);
  }
}

export function assertProbes(probes: readonly Probe[]): void {
  declareProbes(probes);
  for (const probe of probes) {
    let ok = false;
    try {
      ok = probe.check();
    } catch {
      ok = false;
    }
    if (!ok) {
      markBroken(probe.id, `Missing or incompatible ${probe.needs}`);
      throw new Error(`[pi-side-chat] incompatible Pi ${VERSION}: ${probe.needs} (${probe.breaks})`);
    }
  }
}
