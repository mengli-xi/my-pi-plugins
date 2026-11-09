import { ProcessHost, type ProcessHostOptions } from "./process-host.js";

const REGISTRY_KEY = Symbol.for("pi.processes.hosts.v1");

interface HostRegistry {
  version: 1;
  hosts: Map<string, ProcessHost>;
}

function registry(): HostRegistry {
  const globals = globalThis as typeof globalThis & { [REGISTRY_KEY]?: HostRegistry };
  const existing = globals[REGISTRY_KEY];
  if (existing) {
    if (existing.version !== 1 || !(existing.hosts instanceof Map)) throw new Error("[process/registry-incompatible] incompatible host registry");
    return existing;
  }
  const created: HostRegistry = { version: 1, hosts: new Map() };
  Object.defineProperty(globals, REGISTRY_KEY, { value: created, configurable: true, writable: false, enumerable: false });
  return created;
}

export function getOrCreateProcessHost(options: Omit<ProcessHostOptions, "onDisposed">): ProcessHost {
  const holder = registry();
  const existing = holder.hosts.get(options.sessionScopeId);
  if (existing) {
    if (existing.executionAuthority !== options.executionAuthority) throw new Error("[process/execution-isolation] cannot rebind a Host to a different execution authority; start a fresh session");
    return existing;
  }
  const host = new ProcessHost({
    ...options,
    onDisposed: (disposed) => {
      if (holder.hosts.get(options.sessionScopeId) === disposed) holder.hosts.delete(options.sessionScopeId);
    },
  });
  holder.hosts.set(options.sessionScopeId, host);
  return host;
}

export function getProcessHost(sessionScopeId: string): ProcessHost | undefined {
  return registry().hosts.get(sessionScopeId);
}

export function listProcessHosts(): readonly ProcessHost[] {
  return Object.freeze([...registry().hosts.values()]);
}

export async function disposeAllProcessHosts(reason: "pi-exit" | "package-removed" = "pi-exit"): Promise<void> {
  await Promise.allSettled([...registry().hosts.values()].map((host) => host.endScope(reason)));
}
