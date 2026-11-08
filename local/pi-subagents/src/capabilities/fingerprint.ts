import { canonicalJson, sha256Hex } from "./canonical.js";
import type { CapabilitySnapshotV1 } from "../persistence/types.js";

export interface FrozenToolDefinitionV1 {
  readonly name: string;
  readonly owner_id: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly prompt_guidelines: readonly string[];
  readonly source_scope: "builtin" | "user" | "project" | "temporary";
  readonly definition_sha256: string;
}

export function toolDefinitionDigest(input: Omit<FrozenToolDefinitionV1, "source_scope" | "definition_sha256">): string {
  return sha256Hex(canonicalJson({
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    prompt_guidelines: [...input.prompt_guidelines],
    owner_id: input.owner_id,
  }));
}

export function capabilityFingerprint(snapshot: unknown): string {
  return sha256Hex(`pi-subagents/capability/v1\0${canonicalJson(snapshot)}`);
}

export function assertCapabilityFingerprintV1(snapshot: CapabilitySnapshotV1): void {
  const { fingerprint, ...content } = snapshot;
  if (capabilityFingerprint(content) !== fingerprint) throw new Error("capability-drift: frozen capability fingerprint");
}
