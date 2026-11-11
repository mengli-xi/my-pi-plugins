import { validateChildCapabilityManifestV1, type ChildCapabilityManifestV1 } from "#internal/child-capability-manifest";
export interface ChildFactoryProofV1 {
  readonly version: 1;
  readonly manifest: ChildCapabilityManifestV1;
  readonly target_id: string;
  readonly context: Readonly<Record<string, unknown>>;
}
export function validateChildFactoryProofV1(value: unknown, verifyFiles = false): ChildFactoryProofV1 {
  const item = value as ChildFactoryProofV1;
  if (!item || item.version !== 1 || Object.keys(item).sort().join() !== ["version", "manifest", "target_id", "context"].sort().join()
    || typeof item.target_id !== "string" || !item.context || typeof item.context !== "object" || Array.isArray(item.context)
    || Buffer.byteLength(JSON.stringify(item.context)) > 32768) throw new Error("invalid child factory proof");
  const manifest = validateChildCapabilityManifestV1(item.manifest, verifyFiles);
  if (!manifest.targets[item.target_id]?.child_factory) throw new Error("child factory declaration is missing");
  return Object.freeze({ version: 1, manifest, target_id: item.target_id, context: Object.freeze(structuredClone(item.context)) });
}
