import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { captureEntrypointDescriptorV1, type EntrypointDescriptorV1 } from "pi-runtime-contracts/child-capabilities-v1";

type FactoryModule = Readonly<Record<string, unknown>>;
interface LoaderState { readonly importModule: (path: string) => Promise<FactoryModule>; readonly modules: Map<string, Promise<FactoryModule>> }
const loaders = new WeakMap<object, Promise<LoaderState>>();
const realmKey = Symbol.for("pi.session-runtime.factory-loader-realms.v1");
const namespaceNames = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"] as const;
interface FactoryRealms { readonly version: 1; readonly paths: Map<string, readonly (object | undefined)[]>; readonly digests: Map<string, string> }
function claimFactoryRealm(path: string, modules: Readonly<Record<string, object>>): void {
  const global = globalThis as typeof globalThis & { [realmKey]?: FactoryRealms };
  if (!Object.hasOwn(global, realmKey)) Object.defineProperty(global, realmKey, { value: Object.freeze({ version: 1, paths: new Map(), digests: new Map() }) });
  const descriptor = Object.getOwnPropertyDescriptor(global, realmKey)!;
  const realms = descriptor.value as FactoryRealms | undefined;
  if (!realms || realms.version !== 1 || !(realms.paths instanceof Map) || !(realms.digests instanceof Map) || !Object.isFrozen(realms) || descriptor.configurable || descriptor.writable) throw new Error("Incompatible approved factory realm registry");
  const namespaces = namespaceNames.map(name => modules[name]);
  const previous = realms.paths.get(path);
  if (previous && (!Array.isArray(previous) || previous.length !== namespaceNames.length || !Object.isFrozen(previous))) throw new Error("Incompatible approved factory realm registry");
  if (previous && namespaces.some((namespace, index) => namespace !== previous[index])) throw new Error(`Approved factory SDK realm changed for ${path}; use the process-wide session-assembly namespaces`);
  if (!previous) realms.paths.set(path, Object.freeze(namespaces));
}

/**
 * The owner supplies an audited path/export list and public namespaces. SDK children
 * use the actual session-assembly instance's table, not the consumer's own SDK copy.
 * In a compiled Pi host, native import would resolve a second (or missing) Pi copy.
 * Jiti stays lazy, and cached modules never contain per-child options or instances.
 */
export async function loadApprovedFactoryModule(input: {
  readonly path: string;
  readonly exports: readonly string[];
  readonly publicModules: Readonly<Record<string, object>>;
  readonly codeDescriptors?: readonly EntrypointDescriptorV1[];
}): Promise<FactoryModule> {
  if (!isAbsolute(input.path) || input.exports.length === 0 || input.exports.some(name => !/^[A-Za-z_$][\w$]*$/u.test(name))) throw new Error("Invalid approved factory descriptor");
  const identity = input.publicModules["@earendil-works/pi-coding-agent"];
  if (!identity) throw new Error("Host coding-agent namespace is required");
  // Jiti integrates with the process-wide CJS cache even across loader copies. Pin the
  // three Pi namespaces before any import; never return a cached factory from another realm.
  const path = captureEntrypointDescriptorV1(input.path).canonical_path;
  claimFactoryRealm(path, input.publicModules);
  const checkCode = (): void => {
    const realms = (globalThis as typeof globalThis & { [realmKey]: FactoryRealms })[realmKey];
    for (const expected of [captureEntrypointDescriptorV1(path), ...(input.codeDescriptors ?? [])]) {
      const actual = captureEntrypointDescriptorV1(expected.canonical_path);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Approved factory file changed: ${expected.canonical_path}`);
      const previous = realms.digests.get(actual.canonical_path);
      if (previous && previous !== actual.sha256) throw new Error(`Approved factory code changed: ${actual.canonical_path}; start a fresh process`);
      realms.digests.set(actual.canonical_path, actual.sha256);
    }
  };
  checkCode();
  let pending = loaders.get(identity);
  if (!pending) {
    pending = (async () => {
      const { createJiti } = await import("jiti");
      const jiti = createJiti(import.meta.url, { virtualModules: { ...input.publicModules }, tryNative: false, moduleCache: true });
      return { importModule: (path: string) => jiti.import<FactoryModule>(pathToFileURL(path).href), modules: new Map<string, Promise<FactoryModule>>() };
    })();
    loaders.set(identity, pending);
    pending.catch(() => { if (loaders.get(identity) === pending) loaders.delete(identity); });
  }
  const state = await pending;
  let module = state.modules.get(path);
  if (!module) { module = state.importModule(path); state.modules.set(path, module); module.catch(() => { if (state.modules.get(path) === module) state.modules.delete(path); }); }
  const exports = await module;
  checkCode();
  const selected: Record<string, unknown> = {};
  for (const name of input.exports) {
    if (typeof exports[name] !== "function") throw new Error(`Approved factory export is missing: ${name}`);
    selected[name] = exports[name];
  }
  return Object.freeze(selected);
}
