import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ChildEventProcessorV1 } from "../../src/child/events.js";
import type { ChildEventPortV1, ChildEventV1 } from "../../src/child/events.js";
import { canonicalDeliveryJsonV1 } from "../../src/persistence/canonical.js";

const agentId = `agt_${Buffer.alloc(16, 1).toString("base64url")}`; const taskId = `tsk_${Buffer.alloc(16, 2).toString("base64url")}`; const digest = "a".repeat(64);
function fixture(options: { lease?: boolean; runtimeGeneration?: number } = {}) {
  const calls: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = []; let hasLease = options.lease ?? true; const releases: string[] = [];
  const channel = { bootstrap: () => ({ runtimeGeneration: options.runtimeGeneration ?? 7, parentConversationSessionId: "session" }), request: async (type: string, payload: Readonly<Record<string, unknown>>) => { calls.push({ type, payload }); return { hostRevision: calls.length, result: type === "event_ack" ? { acked: true } : { persisted: true } }; }, pendingRequestIds: () => ["request-2", "request-1"] };
  const runtime = { identity: channel.bootstrap, apply: channel.request, ack: (payload: { eventSequence: number; appliedEventIds: string[] }) => channel.request("event_ack", payload), pendingRequestIds: channel.pendingRequestIds, taskLease: (id: string) => hasLease && id === taskId ? { leaseId: "lease", generation: 2, logicalKey: id } : undefined, acquireTaskLease: (id: string) => { const previous = hasLease; hasLease = true; return { leaseId: "lease", generation: previous ? 2 : 3, logicalKey: id }; }, releaseTaskLease: (id: string) => { if (!hasLease || id !== taskId) throw new Error("absent"); hasLease = false; releases.push(id); return { leaseId: "lease", generation: 2 }; }, activeLeaseTaskIds: () => hasLease ? [taskId] : [], appendCompletionCards: (items: any[]) => items.map((item) => ({ inboxId: item.inboxId, completionId: item.completionId, projectionSha256: item.projectionSha256, entryId: "entry" })), isReady: () => true } as unknown as ChildEventPortV1;
  return { runtime, calls, releases };
}
function event(eventKind: string, payload: Record<string, unknown>, sequence = 1): ChildEventV1 { return { eventSequence: sequence, payload: { eventId: `evt_${Buffer.alloc(16, sequence).toString("base64url")}`, eventKind, eventPayloadSha256: digest, payload: { kind: eventKind, ...payload } } }; }

test("confirm and acquire events persist result before ACK", async () => {
  const confirmed = fixture(); await new ChildEventProcessorV1(confirmed.runtime).process(event("confirm_task_commit", { taskId, logicalKey: taskId, operationId: "op", commitRevision: 2, publicResultSha256: digest })); assert.deepEqual(confirmed.calls.map((item) => item.type), ["owner_event_application_result", "event_ack"]); assert.equal(confirmed.calls[0]!.payload.kind, "confirm_task_commit_result");
  const acquired = fixture({ lease: false }); await new ChildEventProcessorV1(acquired.runtime).process(event("acquire_task_lease", { operationId: "op", taskId, logicalKey: taskId, preparedTokenSha256: digest, parentConversationSessionId: "session", expiresAt: "2026-08-18T00:00:00.000Z" })); assert.deepEqual(acquired.calls.map((item) => item.type), ["task_lease_acquired", "event_ack"]); assert.equal((acquired.calls[0]!.payload.lease as any).generation, 3);
});

test("abort-prepared release reports exact local release or source-generation-gone", async () => {
  const live = fixture(); await new ChildEventProcessorV1(live.runtime).process(event("release_task_lease", { mode: "abort-prepared", operationId: "op", operationKind: "spawn", operationDigest: digest, caller: { kind: "agent", session_id: "s", agent_id: agentId }, callerRuntimeGeneration: 7, taskId, logicalKey: taskId, preparedTokenSha256: digest, reasonCode: "caller-aborted", sourceAgentId: agentId, sourceRuntimeGeneration: 7, leaseOutcome: "cancelled" })); assert.deepEqual(live.releases, [taskId]); assert.equal((live.calls[0]!.payload.lease as any).state, "released");
  const replacement = fixture({ lease: false, runtimeGeneration: 8 }); await new ChildEventProcessorV1(replacement.runtime).process({ ...event("release_task_lease", { mode: "abort-prepared", operationId: "op", operationKind: "spawn", operationDigest: digest, caller: { kind: "agent", session_id: "s", agent_id: agentId }, callerRuntimeGeneration: 7, taskId, logicalKey: taskId, preparedTokenSha256: digest, reasonCode: "caller-aborted", sourceAgentId: agentId, sourceRuntimeGeneration: 7, leaseOutcome: "cancelled" }) }); assert.equal((replacement.calls[0]!.payload.lease as any).state, "source-generation-gone");
});

test("health, shutdown and completion delivery persist then ACK", async () => {
  const fx = fixture(); const processor = new ChildEventProcessorV1(fx.runtime); await processor.process(event("owner_health", { state: "degraded", code: "slow" })); assert.equal(fx.calls[0]!.payload.kind, "owner_health_result"); fx.calls.length = 0;
  await processor.process(event("prepare_shutdown", { runtimeGeneration: 7, reason: "idle-evict", deadlineAtMs: 1 })); assert.deepEqual(fx.calls.map((item) => item.type), ["owner_event_application_result", "event_ack"]); assert.deepEqual(fx.calls[0]!.payload.activeLeaseTaskIds, [taskId]);
  fx.calls.length = 0; const items = [{ inboxId: "inb", completionId: "cmp", projectionSha256: digest, content: "done", detailsJson: "{}" }]; const chunkSha256 = createHash("sha256").update(canonicalDeliveryJsonV1(items)).digest("hex"); const windowIdentitySha256 = createHash("sha256").update(canonicalDeliveryJsonV1(items.map((item) => ({ inboxId: item.inboxId, projectionSha256: item.projectionSha256 })))).digest("hex"); await processor.process(event("completion_delivery", { items, chunkSha256, windowIdentitySha256 })); assert.deepEqual(fx.calls.map((item) => item.type), ["owner_event_application_result", "event_ack"]); assert.equal((fx.calls[0]!.payload.cardProofs as any[])[0]!.entryId, "entry");
});

test("failed application persistence retries its retained result without releasing a lease twice", async () => {
  const fx = fixture();
  const original = fx.runtime.apply.bind(fx.runtime);
  let fail = true;
  fx.runtime.apply = async (...args) => { if (fail) { fail = false; throw new Error("temporary store failure"); } return original(...args); };
  const processor = new ChildEventProcessorV1(fx.runtime);
  const release = event("release_task_lease", { taskId, logicalKey: taskId, mode: "abort-prepared", sourceRuntimeGeneration: 7, sourceAgentId: agentId, operationId: "op" });
  await assert.rejects(processor.process(release), /temporary store failure/);
  await processor.process(release);
  assert.deepEqual(fx.releases, [taskId]);
  assert.equal(fx.calls.at(-1)?.type, "event_ack");
});
