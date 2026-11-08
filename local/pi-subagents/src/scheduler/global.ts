import { randomBytes } from "node:crypto";
import { SubagentRuntimeCoordinatorV1 } from "./coordinator.js";
import type { SchedulerIdSourceV1, SchedulerProcessLimitsV1 } from "./types.js";

export const SUBAGENT_RUNTIME_COORDINATOR_V1 = Symbol.for("pi.subagents.runtime-coordinator.v1");

export interface RuntimeCoordinatorClaimV1 {
  readonly coordinator: SubagentRuntimeCoordinatorV1;
  readonly ownerGeneration: number;
  release(): void;
}

export interface RuntimeCoordinatorCellSnapshotV1 {
  readonly version: 1;
  readonly coordinatorGeneration: number;
  readonly ownerGeneration: number;
  readonly ownerActive: boolean;
}

export interface RuntimeCoordinatorCellV1 {
  readonly version: 1;
  readonly operationVersion: 1;
  readonly brand: "pi-subagents-runtime-coordinator-v1";
  claim(input: {
    readonly ownerGeneration: number;
    readonly processLimits: SchedulerProcessLimitsV1;
    readonly idSource?: SchedulerIdSourceV1;
  }): RuntimeCoordinatorClaimV1;
  snapshot(): RuntimeCoordinatorCellSnapshotV1;
}

class CryptoSchedulerIdsV1 implements SchedulerIdSourceV1 {
  next(kind: "binding" | "grant"): string {
    return `${kind}-${randomBytes(16).toString("base64url")}`;
  }
}

function positive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

export function createRuntimeCoordinatorCellV1(): RuntimeCoordinatorCellV1 {
  let coordinator: SubagentRuntimeCoordinatorV1 | undefined;
  let ownerGeneration = 0;
  let ownerActive = false;

  const claim: RuntimeCoordinatorCellV1["claim"] = (input) => {
    positive(input.ownerGeneration, "ownerGeneration");
    if (input.ownerGeneration <= ownerGeneration) throw new Error("runtime coordinator owner generation is stale");
    if (!coordinator) {
      coordinator = new SubagentRuntimeCoordinatorV1({
        generation: 1,
        limits: input.processLimits,
        idSource: input.idSource ?? new CryptoSchedulerIdsV1(),
      });
    } else {
      coordinator.updateProcessLimits(input.processLimits);
    }
    ownerGeneration = input.ownerGeneration;
    ownerActive = true;
    const claimedCoordinator = coordinator;
    let released = false;
    return Object.freeze({
      coordinator: claimedCoordinator,
      ownerGeneration: input.ownerGeneration,
      release() {
        if (released) return;
        released = true;
        if (ownerGeneration !== input.ownerGeneration) return;
        ownerActive = false;
      },
    });
  };

  return Object.freeze({
    version: 1,
    operationVersion: 1,
    brand: "pi-subagents-runtime-coordinator-v1",
    claim,
    snapshot() {
      return Object.freeze({
        version: 1,
        coordinatorGeneration: coordinator?.generation ?? 0,
        ownerGeneration,
        ownerActive,
      });
    },
  });
}

const CELL_KEYS = ["brand", "claim", "operationVersion", "snapshot", "version"];

function compatibleCell(value: unknown): value is RuntimeCoordinatorCellV1 {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join("\0") !== CELL_KEYS.join("\0")) return false;
  const cell = value as Partial<RuntimeCoordinatorCellV1>;
  return cell.version === 1
    && cell.operationVersion === 1
    && cell.brand === "pi-subagents-runtime-coordinator-v1"
    && typeof cell.claim === "function"
    && typeof cell.snapshot === "function";
}

export function getOrCreateRuntimeCoordinatorCellV1(): RuntimeCoordinatorCellV1 {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, SUBAGENT_RUNTIME_COORDINATOR_V1);
  if (descriptor) {
    if (!compatibleCell(descriptor.value)) throw new Error("incompatible pi-subagents runtime coordinator cell");
    return descriptor.value;
  }
  const cell = createRuntimeCoordinatorCellV1();
  Object.defineProperty(globalThis, SUBAGENT_RUNTIME_COORDINATOR_V1, {
    value: cell,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return cell;
}
