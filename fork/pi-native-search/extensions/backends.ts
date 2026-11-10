import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Owner: pi-native-search. Replies must be synchronous; no modules or credentials cross discovery. */
export const SEARCH_BACKENDS_REQUEST_V1 = "native-search:backends-request-v1";
export type SearchBackendEvents = Pick<ExtensionAPI["events"], "emit">;
export interface SearchBackendV1 {
  readonly version: 1;
  readonly id: string;
  readonly label: string;
  readonly defaultProviders: readonly string[];
  readonly search: (input: { query: string; ctx: ExtensionContext; signal?: AbortSignal }) => Promise<string>;
}

export function discoverSearchBackends(events?: SearchBackendEvents): readonly SearchBackendV1[] {
  const backends: SearchBackendV1[] = [];
  let accepting = true;
  let invalid = false;
  events?.emit(SEARCH_BACKENDS_REQUEST_V1, {
    version: 1,
    contribute(value: unknown) {
      if (!accepting) return;
      if (!value || typeof value !== "object") { invalid = true; return; }
      const backend = value as SearchBackendV1;
      if (backend.version !== 1 || typeof backend.id !== "string" || !backend.id.trim() ||
          backend.id === "native" || backend.id === "ddg" || typeof backend.label !== "string" ||
          !backend.label.trim() || !Array.isArray(backend.defaultProviders) ||
          backend.defaultProviders.some(provider => typeof provider !== "string" || !provider.trim()) ||
          typeof backend.search !== "function") { invalid = true; return; }
      backends.push(Object.freeze({ ...backend, defaultProviders: Object.freeze([...backend.defaultProviders]) }));
    },
  });
  accepting = false;
  if (invalid) throw new Error("Search backend discovery: invalid v1 backend");
  const ids = new Set<string>(), providers = new Set<string>();
  for (const backend of backends) {
    if (ids.has(backend.id)) throw new Error(`Search backend conflict: duplicate id ${backend.id}`);
    ids.add(backend.id);
    for (const provider of backend.defaultProviders) {
      if (providers.has(provider)) throw new Error(`Search backend conflict: duplicate default provider ${provider}`);
      providers.add(provider);
    }
  }
  return Object.freeze(backends);
}
