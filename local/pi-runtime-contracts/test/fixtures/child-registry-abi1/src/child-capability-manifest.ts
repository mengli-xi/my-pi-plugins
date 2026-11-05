import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

const ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const HOOK = /^[a-z][a-z0-9._-]{0,63}(?:\/[a-z][a-z0-9._-]{0,63})*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();

export interface EntrypointDescriptorV1 {
  readonly canonical_path: string;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mtime_ns: string;
}

export interface ProviderCapabilityV1 {
  readonly provider_id: string;
  readonly service_tiers: readonly string[];
  readonly service_tier_application: "none" | "owner-before-provider-request";
}

export interface ChildCapabilityTargetV1 {
  readonly child_entrypoint: EntrypointDescriptorV1;
  readonly activation: "mirror" | "required-only";
  readonly commands: readonly string[];
  readonly tools: readonly string[];
  readonly providers: readonly ProviderCapabilityV1[];
  readonly hooks: readonly string[];
  readonly requires: readonly string[];
}

export interface ChildCapabilityManifestV1 {
  readonly version: 1;
  readonly owner_id: string;
  readonly main_entrypoint: EntrypointDescriptorV1;
  readonly targets: Readonly<Record<string, ChildCapabilityTargetV1>>;
}

function fail(message: string): never {
  throw new Error(message);
}

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.includes(key) || !Object.prototype.propertyIsEnumerable.call(record, key)) fail(`${label} contains an unknown key`);
    const property = Object.getOwnPropertyDescriptor(record, key);
    if (!property || property.get || property.set) fail(`${label}.${key} must be a data property`);
  }
  return record;
}

function targetRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("manifest.targets must be a plain object");
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length === 0 || keys.length > 32) fail("manifest.targets must contain 1..32 targets");
  for (const key of keys) {
    if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(record, key)) fail("manifest.targets contains an invalid key");
    id(key, "manifest target id");
    const property = Object.getOwnPropertyDescriptor(record, key);
    if (!property || property.get || property.set) fail(`manifest.targets.${key} must be a data property`);
  }
  return record;
}

function safeString(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.normalize("NFC") !== value || value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || encoder.encode(value).byteLength > max) fail(`${label} is invalid`);
  return value;
}

function id(value: unknown, label: string): string {
  const accepted = safeString(value, label, 64);
  if (!ID.test(accepted)) fail(`${label} has invalid characters`);
  return accepted;
}

function sortedUniqueStrings(value: unknown, label: string, grammar: "string" | "id" | "hook" = "string"): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) fail(`${label} must contain at most 128 values`);
  const result = value.map((item, index) => {
    if (grammar === "id") return id(item, `${label}[${index}]`);
    const accepted = safeString(item, `${label}[${index}]`);
    if (grammar === "hook" && !HOOK.test(accepted)) fail(`${label}[${index}] has invalid hook segments`);
    return accepted;
  });
  const sorted = [...result].sort();
  if (new Set(sorted).size !== sorted.length || result.some((item, index) => item !== sorted[index])) fail(`${label} must be sorted and unique`);
  return Object.freeze(result);
}

function ns(stat: { mtimeNs?: bigint; mtimeMs: number }): string {
  return stat.mtimeNs !== undefined ? String(stat.mtimeNs) : String(BigInt(Math.trunc(stat.mtimeMs * 1_000_000)));
}

export function captureEntrypointDescriptorV1(path: string): EntrypointDescriptorV1 {
  if (!isAbsolute(path)) fail("entrypoint path must be absolute");
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical, { bigint: true });
  if (!stat.isFile() || Number(stat.uid) !== process.getuid?.()) fail("entrypoint must be a current-UID regular file");
  const bytes = readFileSync(canonical);
  return Object.freeze({
    canonical_path: canonical,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    device: String(stat.dev),
    inode: String(stat.ino),
    size: Number(stat.size),
    mtime_ns: ns({ mtimeNs: stat.mtimeNs, mtimeMs: Number(stat.mtimeMs) }),
  });
}

function descriptor(value: unknown, label: string): EntrypointDescriptorV1 {
  const input = exactObject(value, ["canonical_path", "sha256", "device", "inode", "size", "mtime_ns"], label);
  const path = safeString(input.canonical_path, `${label}.canonical_path`, 4096);
  const digest = safeString(input.sha256, `${label}.sha256`, 64);
  if (!SHA256.test(digest)) fail(`${label}.sha256 is invalid`);
  const accepted: EntrypointDescriptorV1 = {
    canonical_path: path,
    sha256: digest,
    device: safeString(input.device, `${label}.device`, 32),
    inode: safeString(input.inode, `${label}.inode`, 32),
    size: Number(input.size),
    mtime_ns: safeString(input.mtime_ns, `${label}.mtime_ns`, 32),
  };
  if (!Number.isSafeInteger(accepted.size) || accepted.size < 0) fail(`${label}.size is invalid`);
  const actual = captureEntrypointDescriptorV1(path);
  if (JSON.stringify(actual) !== JSON.stringify(accepted)) fail(`${label} does not match the live file identity`);
  return actual;
}

function provider(value: unknown, index: number, label: string): ProviderCapabilityV1 {
  const itemLabel = `${label}[${index}]`;
  const input = exactObject(value, ["provider_id", "service_tiers", "service_tier_application"], itemLabel);
  const application = input.service_tier_application;
  if (application !== "none" && application !== "owner-before-provider-request") fail(`${itemLabel}.service_tier_application is invalid`);
  return Object.freeze({
    provider_id: id(input.provider_id, `${itemLabel}.provider_id`),
    service_tiers: sortedUniqueStrings(input.service_tiers, `${itemLabel}.service_tiers`),
    service_tier_application: application,
  });
}

function target(value: unknown, targetId: string): ChildCapabilityTargetV1 {
  const label = `manifest.targets.${targetId}`;
  const input = exactObject(value, ["child_entrypoint", "activation", "commands", "tools", "providers", "hooks", "requires"], label);
  if (input.activation !== "mirror" && input.activation !== "required-only") fail(`${label}.activation is invalid`);
  if (!Array.isArray(input.providers) || input.providers.length > 128) fail(`${label}.providers must contain at most 128 values`);
  const providers = input.providers.map((item, index) => provider(item, index, `${label}.providers`));
  if (providers.some((item, index) => index > 0 && providers[index - 1]!.provider_id >= item.provider_id)) fail(`${label}.providers must be sorted and unique by provider_id`);
  return Object.freeze({
    child_entrypoint: descriptor(input.child_entrypoint, `${label}.child_entrypoint`),
    activation: input.activation,
    commands: sortedUniqueStrings(input.commands, `${label}.commands`),
    tools: sortedUniqueStrings(input.tools, `${label}.tools`),
    providers: Object.freeze(providers),
    hooks: sortedUniqueStrings(input.hooks, `${label}.hooks`, "hook"),
    requires: sortedUniqueStrings(input.requires, `${label}.requires`, "id"),
  });
}

export function validateChildCapabilityManifestV1(value: unknown): ChildCapabilityManifestV1 {
  const input = exactObject(value, ["version", "owner_id", "main_entrypoint", "targets"], "manifest");
  if (input.version !== 1) fail("manifest.version must equal 1");
  const rawTargets = targetRecord(input.targets);
  const targets: Record<string, ChildCapabilityTargetV1> = {};
  for (const targetId of Object.keys(rawTargets).sort()) targets[targetId] = target(rawTargets[targetId], targetId);
  return Object.freeze({
    version: 1,
    owner_id: id(input.owner_id, "manifest.owner_id"),
    main_entrypoint: descriptor(input.main_entrypoint, "manifest.main_entrypoint"),
    targets: Object.freeze(targets),
  });
}

export function canonicalChildCapabilityManifestV1(manifest: ChildCapabilityManifestV1): string {
  return JSON.stringify(manifest);
}
