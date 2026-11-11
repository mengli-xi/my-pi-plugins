import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateChildCapabilityManifestV1, type ChildCapabilityManifestV1, type ChildCapabilityRegistrySnapshotV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { PROVIDER_ACTIVITY_CHANNEL, readProviderActivityV1 } from "pi-runtime-contracts/provider-activity-v1";
import { loadApprovedFactoryModule } from "pi-session-runtime/factory-loader";

export interface SdkProviderApprovalV1 {
  readonly owner_id: string;
  readonly target_id: string;
  /** Exactly one target. This approves the actual Main, child, package, factory and delegates. */
  readonly manifest: ChildCapabilityManifestV1;
}
export interface SdkProviderProofV1 extends SdkProviderApprovalV1 {
  readonly version: 1;
  readonly model_scope: readonly string[];
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`Invalid ${label}`);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !keys.includes(key) || !property?.enumerable || property.get || property.set) throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}
const packageNames = new Map<string, { name?: string; error?: Error }>();
function actualPackage(modulePath: string): string {
  for (let directory = dirname(modulePath); ; directory = dirname(directory)) {
    const path = join(directory, "package.json");
    try { lstatSync(path); return realpathSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(directory) === directory) throw new Error("SDK factory has no actual package manifest");
  }
}
function approval(value: unknown, live: boolean): SdkProviderApprovalV1 {
  const item = exact(value, ["owner_id", "target_id", "manifest"], "SDK provider approval");
  const manifest = validateChildCapabilityManifestV1(item.manifest, live);
  if (item.owner_id !== manifest.owner_id || typeof item.target_id !== "string" || Object.keys(manifest.targets).length !== 1 || !manifest.targets[item.target_id]?.sdk_provider_factory) throw new Error("SDK provider approval must name its exact owner and target");
  const target = manifest.targets[item.target_id]!;
  const factory = target.sdk_provider_factory!;
  if (target.providers.length !== 1 || target.providers[0]!.provider_id !== factory.provider_id || target.tools.length || target.commands.length || target.requires.length) throw new Error("SDK provider target must declare only its provider");
  if (basename(factory.package_manifest.canonical_path) !== "package.json") throw new Error("SDK provider package descriptor must name package.json");
  if (live) {
    if (actualPackage(factory.module.canonical_path) !== factory.package_manifest.canonical_path || actualPackage(target.child_entrypoint.canonical_path) !== factory.package_manifest.canonical_path) throw new Error("SDK provider descriptor is not its actual package manifest");
    const key = `${factory.package_manifest.canonical_path}:${factory.package_manifest.sha256}`;
    let cached = packageNames.get(key);
    if (!cached) {
      try {
        const pkg = JSON.parse(readFileSync(factory.package_manifest.canonical_path, "utf8"));
        if (typeof pkg.name !== "string" || !pkg.name) throw new Error("SDK provider package manifest has no name");
        cached = { name: pkg.name };
      } catch (error) { cached = { error: error instanceof Error ? error : new Error(String(error)) }; }
      if (packageNames.size >= 128) packageNames.delete(packageNames.keys().next().value!);
      packageNames.set(key, cached);
    }
    if (cached.error) throw cached.error;
  }
  return Object.freeze({ owner_id: manifest.owner_id, target_id: item.target_id, manifest });
}
/** Pure decoding keeps old profiles/history readable without authorizing execution. */
export function decodeSdkProviderProofV1(value: unknown): SdkProviderProofV1 {
  const item = exact(value, ["version", "owner_id", "target_id", "manifest", "model_scope"], "SDK provider proof");
  if (item.version !== 1 || !Array.isArray(item.model_scope) || item.model_scope.length > 4096 || item.model_scope.some(id => typeof id !== "string" || id.length > 512 || !id.includes("/")) || new Set(item.model_scope).size !== item.model_scope.length) throw new Error("Invalid SDK provider proof scope");
  return Object.freeze({ version: 1, ...approval({ owner_id: item.owner_id, target_id: item.target_id, manifest: item.manifest }, false), model_scope: Object.freeze([...item.model_scope] as string[]) });
}
const grantCache = new Map<string, { signal: string; grants?: readonly SdkProviderApprovalV1[]; error?: Error }>();
function grants(agentDir: string): readonly SdkProviderApprovalV1[] {
  const path = join(realpathSync(agentDir), "sdk-provider-grants.json");
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.uid) !== process.getuid?.() || realpathSync(path) !== path) throw new Error("SDK provider grants must be a canonical current-UID regular file");
  const signal = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  const previous = grantCache.get(path);
  if (previous?.signal === signal) { if (previous.error) throw previous.error; return previous.grants!; }
  try {
    if (stat.size > 2_097_152n) throw new Error("SDK provider grants exceed bounds");
    const document = exact(JSON.parse(readFileSync(path, "utf8")), ["version", "grants"], "SDK provider grants");
    const after = lstatSync(path, { bigint: true });
    if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":") !== signal) throw new Error("SDK provider grants changed while reading");
    if (document.version !== 1 || !Array.isArray(document.grants) || document.grants.length > 128) throw new Error("Invalid SDK provider grants");
    const accepted = Object.freeze(document.grants.map(item => approval(item, false)));
    if (new Set(accepted.map(item => `${item.owner_id}/${item.target_id}`)).size !== accepted.length) throw new Error("Duplicate SDK provider grant");
    if (grantCache.size >= 64) grantCache.delete(grantCache.keys().next().value!);
    grantCache.set(path, { signal, grants: accepted });
    return accepted;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (grantCache.size >= 64) grantCache.delete(grantCache.keys().next().value!);
    grantCache.set(path, { signal, error: failure });
    throw failure;
  }
}
export function sdkProviderApprovalV1(manifest: ChildCapabilityManifestV1, targetId: string): SdkProviderApprovalV1 {
  const target = manifest.targets[targetId];
  if (!target) throw new Error(`SDK provider target is unavailable: ${targetId}`);
  return approval({ owner_id: manifest.owner_id, target_id: targetId, manifest: { ...manifest, targets: { [targetId]: target } } }, true);
}
export function approveSdkProviderV1(agentDir: string, manifest: ChildCapabilityManifestV1, targetId: string, modelScope: readonly string[]): SdkProviderProofV1 {
  const current = sdkProviderApprovalV1(manifest, targetId);
  const providerId = current.manifest.targets[targetId]!.sdk_provider_factory!.provider_id;
  try {
    if (!grants(agentDir).some(grant => canonical(grant) === canonical(current))) throw new Error("没有匹配当前声明的批准");
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    const reason = missing ? "批准文件不存在" : cause instanceof Error && cause.message === "没有匹配当前声明的批准" ? "没有匹配当前声明的批准（no exact grant）" : "批准文件损坏或不可读取";
    throw new Error(`SDK provider 未授权：${providerId}（owner: ${manifest.owner_id}，target: ${targetId}）；${reason}。请在 ${join(agentDir, "sdk-provider-grants.json")} 中审阅并批准此 provider 的 ${targetId} 声明。`, { cause });
  }
  return decodeSdkProviderProofV1({ version: 1, ...current, model_scope: [...modelScope] });
}
export function sdkProviderProofNarrowsV1(child: SdkProviderProofV1 | undefined, parent: SdkProviderProofV1 | undefined): boolean {
  if (!child || !parent) return child === parent;
  return canonical({ ...child, model_scope: [] }) === canonical({ ...parent, model_scope: [] }) && child.model_scope.every(id => parent.model_scope.includes(id));
}
export function revalidateSdkProviderProofV1(proof: SdkProviderProofV1, agentDir: string, targetId: string, modelScope: readonly string[]): void {
  const parsed = decodeSdkProviderProofV1(proof);
  if (parsed.target_id !== targetId || canonical(parsed.model_scope) !== canonical(modelScope)) throw new Error("SDK provider proof target/model scope changed");
  approveSdkProviderV1(agentDir, parsed.manifest, targetId, modelScope);
}
/** Admission must diagnose the selected declaration BEFORE discovery hides unapproved models.
 * No declaration means no new authority/error; consumers retain their unsupported-provider policy.
 */
export function assertSdkProviderModelApprovedV1(snapshot: ChildCapabilityRegistrySnapshotV1, agentDir: string, targetId: string, providerId: string): void {
  if (snapshot.conflicts.length) throw new Error("SDK provider registry conflict");
  for (const item of snapshot.registrations) {
    if (item.manifest.targets[targetId]?.sdk_provider_factory?.provider_id === providerId) {
      approveSdkProviderV1(agentDir, item.manifest, targetId, []);
    }
  }
}
export function approvedSdkProviderRegistrationsV1(snapshot: ChildCapabilityRegistrySnapshotV1, agentDir: string, targetId: string) {
  if (snapshot.conflicts.length) throw new Error("SDK provider registry conflict");
  return snapshot.registrations.filter(item => {
    if (!item.manifest.targets[targetId]?.sdk_provider_factory) return false;
    try { approveSdkProviderV1(agentDir, item.manifest, targetId, []); return true; } catch { return false; }
  });
}

/** Public references/bindings are cooperative replacement fences, not host-attested provenance. */
export function sdkProviderBindingFenceV1(snapshot: ChildCapabilityRegistrySnapshotV1, current: () => ChildCapabilityRegistrySnapshotV1, ownerId: string, proof?: SdkProviderProofV1): () => void {
  const expected = snapshot.registrations.find(item => item.owner_id === ownerId);
  if (!expected) throw new Error(`SDK provider owner unavailable: ${ownerId}`);
  if (proof && canonical(sdkProviderApprovalV1(expected.manifest, proof.target_id)) !== canonical({ owner_id: proof.owner_id, target_id: proof.target_id, manifest: proof.manifest })) throw new Error("SDK provider proof differs from current declaration");
  return () => {
    const live = current();
    const actual = live.registrations.find(item => item.owner_id === ownerId);
    if (live.conflicts.length || !actual || actual.owner_generation !== expected.owner_generation || actual.bind_ordinal !== expected.bind_ordinal || canonical(actual.manifest) !== canonical(expected.manifest)) throw new Error(`SDK provider binding changed: ${ownerId}`);
  };
}

export async function loadSdkProviderFactoryV1(input: {
  proof: SdkProviderProofV1; agentDir: string; target: string; modelScope: readonly string[];
  publicModules: Readonly<Record<string, object>>; fence?: () => void; onDispose?: (dispose: () => void) => void;
}): Promise<ExtensionFactory> {
  const check = () => { input.fence?.(); revalidateSdkProviderProofV1(input.proof, input.agentDir, input.target, input.modelScope); };
  check();
  const descriptor = input.proof.manifest.targets[input.target]!.sdk_provider_factory!;
  const codeDescriptors = [descriptor.module, ...descriptor.artifacts, ...(descriptor.observer ? [descriptor.observer.module] : [])];
  const factoryModule = await loadApprovedFactoryModule({ path: descriptor.module.canonical_path, exports: [descriptor.export], publicModules: input.publicModules, codeDescriptors });
  const observerModule = descriptor.observer ? await loadApprovedFactoryModule({ path: descriptor.observer.module.canonical_path, exports: [descriptor.observer.export], publicModules: input.publicModules, codeDescriptors }) : undefined;
  check();
  const options = Object.freeze({ version: 1 as const, target: input.target, agentDir: input.agentDir, providerId: descriptor.provider_id,
    modelIds: Object.freeze(input.modelScope.filter(id => id.startsWith(`${descriptor.provider_id}/`)).map(id => id.slice(descriptor.provider_id.length + 1))), config: descriptor.config });
  const create = factoryModule[descriptor.export] as (input: typeof options) => ExtensionFactory;
  const factory = create(options);
  if (typeof factory !== "function") throw new Error("SDK provider factory returned no extension");
  return async (pi: ExtensionAPI) => {
    check();
    let dispose: (() => void) | undefined;
    const listeners = new Set<() => void>();
    const cleanup = () => { try { dispose?.(); } finally { dispose = undefined; for (const off of listeners) off(); listeners.clear(); } };
    input.onDispose?.(cleanup);
    try {
      if (descriptor.observer && observerModule) {
        const observer = descriptor.observer;
        const install = observerModule[observer.export] as (bus: { on: (channel: string, listener: (value: unknown) => void) => () => void; emit: (channel: string, value: unknown) => void }) => () => void;
        const installed = install(Object.freeze({
          on(channel: string, listener: (value: unknown) => void) {
            if (channel !== observer.input_channel) throw new Error("SDK observer subscribed to an undeclared channel");
            const off = pi.events.on(channel, listener); listeners.add(off);
            return () => { listeners.delete(off); off(); };
          },
          emit(channel: string, value: unknown) {
            const activity = readProviderActivityV1(value);
            if (channel !== PROVIDER_ACTIVITY_CHANNEL || !activity || activity.provider !== descriptor.provider_id) throw new Error("SDK observer emitted invalid provider activity");
            pi.events.emit(channel, activity);
          },
        }));
        if (typeof installed !== "function") throw new Error("SDK observer returned no disposer");
        dispose = installed;
      }
      pi.on("session_shutdown", cleanup);
      await factory(pi);
      check();
    } catch (error) { cleanup(); throw error; }
  };
}
