import type { ChildCapabilityRegistrySnapshotV1 } from "../capabilities/registry.js";
import type { AgentId, TaskId } from "../domain/types.js";
import type { SpawnPreparationV1 } from "../host/types.js";
import type { CollaborationToolName } from "../tools/results.js";

export interface ChildToolReply { hostRevision: number; result: Readonly<Record<string, unknown>> }
export interface ChildPreparedArtifacts { agentId: AgentId; taskId: TaskId; preparation: SpawnPreparationV1 }
export interface ChildToolPort {
  readonly agentDirectory: string;
  readonly capabilitySnapshot?: ChildCapabilityRegistrySnapshotV1;
  assertReady(): void;
  identity(): { agentId: AgentId; sessionId: string; generation: number; taskPath: string; depth: number };
  revision(): number;
  taskId(): string;
  acquireTaskLease(taskId: string): { leaseId: string; generation: number; logicalKey: string };
  prepare(input: { requestId: string; kind: "spawn" | "followup"; payload: Readonly<Record<string, unknown>>; artifacts?: ChildPreparedArtifacts }): Promise<ChildToolReply>;
  commit(input: { requestId: string; preparedToken: string; taskId: string; lease: { leaseId: string; generation: number; logicalKey: string } }): Promise<ChildToolReply>;
  abort(input: { requestId: string; preparedToken: string; taskId: string; reason: string }): Promise<ChildToolReply>;
  collaborate(tool: CollaborationToolName, payload: Readonly<Record<string, unknown>>): Promise<ChildToolReply>;
  finish(payload: Readonly<Record<string, unknown>>): Promise<ChildToolReply>;
}
