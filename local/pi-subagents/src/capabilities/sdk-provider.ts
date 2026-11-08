import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { approveSdkProviderV1 } from "pi-session-runtime/sdk-provider";
import type { ChildCapabilityRegistrySnapshotV1 } from "./registry.js";

/** Discovery checks data/files/grants only; it must never import a provider factory. */
export function supportsSdkProviderV1(owner: ChildCapabilityRegistrySnapshotV1["registrations"][number], providerId: string, agentDir = getAgentDir()): boolean {
  try {
    const factory = owner.manifest.targets["pi-subagents"]?.sdk_provider_factory;
    if (factory?.provider_id !== providerId) return false;
    approveSdkProviderV1(agentDir, owner.manifest, "pi-subagents", []);
    return true;
  } catch { return false; }
}
