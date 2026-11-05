import type { ChildCapabilityManifestV1, ChildCapabilityTargetV1 } from "#internal/child-capability-manifest";
import type { ChildCapabilityRegistrySnapshotV1 } from "#internal/child-capability-registry";

const ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const CAPABILITY = /^([a-z][a-z0-9._-]{0,63})\/([a-z][a-z0-9._-]{0,63}(?:\/[a-z][a-z0-9._-]{0,63})*)$/u;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

export interface ResolvedChildCapabilityOwnerV1 {
  readonly owner_id: string;
  readonly owner_generation: number;
  readonly bind_ordinal: number;
  readonly target_id: string;
  readonly manifest: ChildCapabilityManifestV1;
  readonly target: ChildCapabilityTargetV1;
}

export interface ChildCapabilityClosureV1 {
  readonly version: 1;
  readonly target_id: string;
  readonly owners: readonly ResolvedChildCapabilityOwnerV1[];
  readonly child_entrypoints: readonly string[];
}

export interface ResolveChildCapabilityClosureInputV1 {
  readonly snapshot: ChildCapabilityRegistrySnapshotV1;
  readonly target_id: string;
  readonly required_owner_ids: readonly string[];
  readonly active_commands: readonly string[];
  readonly active_tools: readonly string[];
  readonly active_providers: readonly string[];
  readonly required_capabilities: readonly string[];
}

type Registration = ChildCapabilityRegistrySnapshotV1["registrations"][number];

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function strings(value: unknown, label: string, grammar: "id" | "capability" | "name"): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} must contain at most 256 values`);
  const result = value.map((item, index) => {
    if (grammar === "id") return identifier(item, `${label}[${index}]`);
    if (typeof item !== "string" || item.length === 0 || Buffer.byteLength(item) > 256 || item.normalize("NFC") !== item || CONTROLS.test(item)) throw new Error(`${label}[${index}] is invalid`);
    if (grammar === "capability" && !CAPABILITY.test(item)) throw new Error(`${label}[${index}] is invalid`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
}

function intersects(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.some((value) => right.has(value));
}

export function resolveChildCapabilityClosureV1(input: ResolveChildCapabilityClosureInputV1): ChildCapabilityClosureV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("child capability closure input must be an object");
  const targetId = identifier(input.target_id, "target_id");
  if (input.snapshot.conflicts.length > 0) throw new Error(`child capability registry conflict: ${input.snapshot.conflicts.map((item) => item.owner_id).join(",")}`);
  const requiredOwnerIds = strings(input.required_owner_ids, "required_owner_ids", "id");
  const activeCommands = new Set(strings(input.active_commands, "active_commands", "name"));
  const activeTools = new Set(strings(input.active_tools, "active_tools", "name"));
  const activeProviders = new Set(strings(input.active_providers, "active_providers", "id"));
  const requiredCapabilities = strings(input.required_capabilities, "required_capabilities", "capability");
  const registrations = new Map(input.snapshot.registrations.map((entry) => [entry.owner_id, entry]));
  const targets = new Map<string, ChildCapabilityTargetV1>();
  for (const registration of input.snapshot.registrations) {
    const target = registration.manifest.targets[targetId];
    if (target) targets.set(registration.owner_id, target);
  }
  const selected = new Set<string>();

  const requireTarget = (ownerId: string, reason: string): { registration: Registration; target: ChildCapabilityTargetV1 } => {
    const registration = registrations.get(ownerId);
    if (!registration) throw new Error(`child capability owner is unavailable: ${ownerId} (${reason})`);
    const target = targets.get(ownerId);
    if (!target) throw new Error(`child capability target '${targetId}' is unavailable for owner '${ownerId}' (${reason})`);
    return { registration, target };
  };

  for (const ownerId of requiredOwnerIds) {
    requireTarget(ownerId, "required owner");
    selected.add(ownerId);
  }
  for (const capability of requiredCapabilities) {
    const match = CAPABILITY.exec(capability)!;
    const ownerId = match[1]!;
    const { target } = requireTarget(ownerId, `required capability ${capability}`);
    if (!target.hooks.includes(match[2]!)) throw new Error(`required child capability is unavailable: ${capability}`);
    selected.add(ownerId);
  }
  for (const registration of input.snapshot.registrations) {
    const target = targets.get(registration.owner_id);
    if (!target) continue;
    const abilityMatch = intersects(target.commands, activeCommands)
      || intersects(target.tools, activeTools)
      || target.providers.some((provider) => activeProviders.has(provider.provider_id));
    if (abilityMatch || (target.activation === "mirror" && target.hooks.length > 0)) selected.add(registration.owner_id);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ownerId: string): void => {
    if (visiting.has(ownerId)) throw new Error(`child capability dependency cycle: ${ownerId}`);
    if (visited.has(ownerId)) return;
    const { registration, target } = requireTarget(ownerId, "selected owner");
    visiting.add(ownerId);
    for (const dependencyId of target.requires) {
      const dependency = requireTarget(dependencyId, `dependency of ${ownerId}`);
      selected.add(dependencyId);
      visit(dependencyId);
      if (dependency.registration.bind_ordinal >= registration.bind_ordinal) throw new Error(`child capability dependency bound after dependent: ${dependencyId}`);
    }
    visiting.delete(ownerId);
    visited.add(ownerId);
  };
  for (const ownerId of [...selected]) visit(ownerId);

  const owners = [...selected]
    .map((ownerId): ResolvedChildCapabilityOwnerV1 => {
      const { registration, target } = requireTarget(ownerId, "resolved owner");
      return Object.freeze({
        owner_id: ownerId,
        owner_generation: registration.owner_generation,
        bind_ordinal: registration.bind_ordinal,
        target_id: targetId,
        manifest: registration.manifest,
        target,
      });
    })
    .sort((left, right) => left.bind_ordinal - right.bind_ordinal || left.owner_id.localeCompare(right.owner_id));
  const childEntrypoints = owners.map((owner) => owner.target.child_entrypoint.canonical_path);
  if (new Set(childEntrypoints).size !== childEntrypoints.length) throw new Error("child entrypoint is claimed by multiple selected owners");
  return Object.freeze({
    version: 1,
    target_id: targetId,
    owners: Object.freeze(owners),
    child_entrypoints: Object.freeze(childEntrypoints),
  });
}
