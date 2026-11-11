import { randomBytes } from "node:crypto";
import {
  canonicalChildCapabilityManifestV1,
  type ChildCapabilityManifestV1,
  validateChildCapabilityManifestV1,
} from "#internal/child-capability-manifest";

// The export/API spelling follows the V1 manifest/request DTOs. Storage ABI 2
// owns the expanded SDK factory schema; never adopt or mutate an ABI-1 manager
// whose register closure may still enforce the earlier closed target schema.
export const CHILD_CAPABILITY_REGISTRY_V1 = Symbol.for("pi.child-capability-registry.v2");
export const PI_CHILD_RUNTIME_TARGET = "PI_CHILD_RUNTIME_TARGET";

export interface ChildCapabilityRegistrationV1 {
  readonly version: 1;
  readonly manifest: ChildCapabilityManifestV1;
}

export interface ChildCapabilityBindingV1 {
  readonly version: 1;
  readonly registrationToken: string;
  readonly session_id: string;
  readonly runtime_generation: number;
  readonly mode: "tui" | "rpc" | "print";
  readonly capture_context?: () => Readonly<Record<string, unknown>>;
}

export interface ChildCapabilityRegistrationHandleV1 {
  readonly registrationToken: string;
  release(): void;
}

export interface ChildCapabilityBindingHandleV1 {
  readonly bindingToken: string;
  release(): void;
}

export interface ChildCapabilityRegistrySnapshotV1 {
  readonly version: 1;
  readonly registry_revision: number;
  readonly session_id: string;
  readonly registrations: readonly Readonly<{
    owner_id: string;
    owner_generation: number;
    bind_ordinal: number;
    manifest: ChildCapabilityManifestV1;
    factory_context?: Readonly<Record<string, unknown>>;
  }>[];
  readonly conflicts: readonly Readonly<{
    owner_id: string;
    code: "manifest-drift";
  }>[];
}

/** V1 request/snapshot API backed by storage/manager ABI 2. */
export interface ChildCapabilityRegistryV1 {
  readonly version: 2;
  readonly brand: "pi-child-capability-registry-v2";
  register(input: ChildCapabilityRegistrationV1): ChildCapabilityRegistrationHandleV1;
  bind(input: ChildCapabilityBindingV1): ChildCapabilityBindingHandleV1;
  snapshot(sessionId: string): ChildCapabilityRegistrySnapshotV1;
}

interface RegistrationRecord {
  token: string;
  generation: number;
  manifest: ChildCapabilityManifestV1;
  canonical: string;
}

interface BindingRecord {
  token: string;
  registrationToken: string;
  ownerId: string;
  ownerGeneration: number;
  sessionId: string;
  runtimeGeneration: number;
  mode: "tui" | "rpc" | "print";
  bindOrdinal: number;
  captureContext?: () => Readonly<Record<string, unknown>>;
}

interface OwnerSlot {
  generation: number;
  candidates: Map<string, RegistrationRecord>;
}

interface RegistryCellV2 extends ChildCapabilityRegistryV1 {
  readonly operationVersion: 2;
}

const CELL_KEYS = ["bind", "brand", "operationVersion", "register", "snapshot", "version"];
const SESSION_ID_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

function token(): string {
  return randomBytes(16).toString("base64url");
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || SESSION_ID_CONTROLS.test(value)) {
    throw new Error("session_id must be 1..512 characters without controls");
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) throw new Error("child capability snapshot contains a cycle");
  seen.add(value as object);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item, seen);
  seen.delete(value as object);
  return Object.freeze(value);
}

function currentCandidate(slot: OwnerSlot): RegistrationRecord | undefined {
  return [...slot.candidates.values()].sort((left, right) => right.generation - left.generation)[0];
}

function slotConflict(slot: OwnerSlot): "manifest-drift" | undefined {
  const manifests = new Set([...slot.candidates.values()].map((candidate) => candidate.canonical));
  return manifests.size > 1 ? "manifest-drift" : undefined;
}

export function createChildCapabilityRegistryV1(): ChildCapabilityRegistryV1 {
  const owners = new Map<string, OwnerSlot>();
  const bindings = new Map<string, BindingRecord>();
  let revision = 0;
  let bindOrdinal = 0;

  const register = (input: ChildCapabilityRegistrationV1): ChildCapabilityRegistrationHandleV1 => {
    if (!input || input.version !== 1 || Object.keys(input).some((key) => key !== "version" && key !== "manifest")) {
      throw new Error("child capability registration must be a closed version 1 object");
    }
    const manifest = validateChildCapabilityManifestV1(input.manifest);
    let slot = owners.get(manifest.owner_id);
    if (!slot) {
      slot = { generation: 0, candidates: new Map() };
      owners.set(manifest.owner_id, slot);
    }
    const registrationToken = token();
    const record: RegistrationRecord = {
      token: registrationToken,
      generation: ++slot.generation,
      manifest,
      canonical: canonicalChildCapabilityManifestV1(manifest),
    };
    slot.candidates.set(registrationToken, record);
    revision++;
    let released = false;
    return Object.freeze({
      registrationToken,
      release() {
        if (released) return;
        released = true;
        const currentSlot = owners.get(manifest.owner_id);
        if (!currentSlot?.candidates.delete(registrationToken)) return;
        for (const [bindingToken, binding] of bindings) {
          if (binding.registrationToken === registrationToken) bindings.delete(bindingToken);
        }
        if (currentSlot.candidates.size === 0) owners.delete(manifest.owner_id);
        revision++;
      },
    });
  };

  const bind = (input: ChildCapabilityBindingV1): ChildCapabilityBindingHandleV1 => {
    if (!input || input.version !== 1 || Object.keys(input).some((key) => !["version", "registrationToken", "session_id", "runtime_generation", "mode", "capture_context"].includes(key))) {
      throw new Error("child capability binding must be a closed version 1 object");
    }
    const sessionId = validateSessionId(input.session_id);
    if (!Number.isSafeInteger(input.runtime_generation) || input.runtime_generation <= 0) throw new Error("runtime_generation must be a positive safe integer");
    if (input.capture_context !== undefined && typeof input.capture_context !== "function") throw new Error("capture_context must be a function");
    if (input.mode !== "tui" && input.mode !== "rpc" && input.mode !== "print") throw new Error("binding mode is invalid");
    let ownerId: string | undefined;
    let slot: OwnerSlot | undefined;
    let registration: RegistrationRecord | undefined;
    for (const [candidateOwner, candidateSlot] of owners) {
      const found = candidateSlot.candidates.get(input.registrationToken);
      if (found) {
        ownerId = candidateOwner;
        slot = candidateSlot;
        registration = found;
        break;
      }
    }
    if (!ownerId || !slot || !registration) throw new Error("registration token is stale");
    if (slotConflict(slot)) throw new Error(`owner '${ownerId}' is conflicted`);
    if (currentCandidate(slot)?.token !== registration.token) throw new Error("registration token has been superseded");
    const existing = [...bindings.values()].find((binding) => binding.ownerId === ownerId && binding.sessionId === sessionId);
    if (existing && existing.runtimeGeneration >= input.runtime_generation) throw new Error("runtime generation must replace the current binding");
    if (existing) bindings.delete(existing.token);
    const bindingToken = token();
    const record: BindingRecord = {
      token: bindingToken,
      registrationToken: registration.token,
      ownerId,
      ownerGeneration: registration.generation,
      sessionId,
      runtimeGeneration: input.runtime_generation,
      mode: input.mode,
      bindOrdinal: ++bindOrdinal,
      captureContext: input.capture_context,
    };
    bindings.set(bindingToken, record);
    revision++;
    let released = false;
    return Object.freeze({
      bindingToken,
      release() {
        if (released) return;
        released = true;
        if (bindings.get(bindingToken) !== record) return;
        bindings.delete(bindingToken);
        revision++;
      },
    });
  };

  const snapshot = (rawSessionId: string): ChildCapabilityRegistrySnapshotV1 => {
    const sessionId = validateSessionId(rawSessionId);
    const registrations: Array<ChildCapabilityRegistrySnapshotV1["registrations"][number]> = [];
    const conflicts: Array<ChildCapabilityRegistrySnapshotV1["conflicts"][number]> = [];
    for (const [ownerId, slot] of [...owners].sort(([left], [right]) => left.localeCompare(right))) {
      const conflict = slotConflict(slot);
      if (conflict) {
        conflicts.push({ owner_id: ownerId, code: conflict });
        continue;
      }
      const current = currentCandidate(slot);
      if (!current) continue;
      const binding = [...bindings.values()].find((item) => item.registrationToken === current.token && item.sessionId === sessionId);
      if (!binding) continue;
      let context: Readonly<Record<string, unknown>> | undefined;
      if (binding.captureContext) {
        try { context = structuredClone(binding.captureContext()); if (!context || typeof context !== "object" || Array.isArray(context) || Buffer.byteLength(JSON.stringify(context)) > 32768) throw new Error("invalid factory context"); }
        catch (error) { console.warn(`child factory ${ownerId}: context capture failed: ${String(error)}`); context = {}; }
      }
      registrations.push({
        owner_id: ownerId,
        owner_generation: current.generation,
        bind_ordinal: binding.bindOrdinal,
        manifest: current.manifest,
        ...(context ? { factory_context: context } : {}),
      });
    }
    registrations.sort((left, right) => left.bind_ordinal - right.bind_ordinal || left.owner_id.localeCompare(right.owner_id));
    return deepFreeze({
      version: 1,
      registry_revision: revision,
      session_id: sessionId,
      registrations,
      conflicts,
    });
  };

  return Object.freeze({
    version: 2,
    brand: "pi-child-capability-registry-v2",
    register,
    bind,
    snapshot,
  });
}

function compatibleCell(value: unknown): value is RegistryCellV2 {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join("\0") !== CELL_KEYS.join("\0")) return false;
  const cell = value as Partial<RegistryCellV2>;
  return cell.version === 2 && cell.operationVersion === 2 && cell.brand === "pi-child-capability-registry-v2" && typeof cell.register === "function" && typeof cell.bind === "function" && typeof cell.snapshot === "function";
}

export function getOrCreateChildCapabilityRegistryV1(): ChildCapabilityRegistryV1 {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, CHILD_CAPABILITY_REGISTRY_V1);
  if (descriptor) {
    if (!compatibleCell(descriptor.value)) throw new Error("incompatible Pi child capability registry cell");
    return descriptor.value;
  }
  const registry = createChildCapabilityRegistryV1();
  const cell: RegistryCellV2 = Object.freeze({
    version: 2,
    operationVersion: 2,
    brand: "pi-child-capability-registry-v2",
    register: registry.register,
    bind: registry.bind,
    snapshot: registry.snapshot,
  });
  Object.defineProperty(globalThis, CHILD_CAPABILITY_REGISTRY_V1, {
    value: cell,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return cell;
}
