import { createHash } from "node:crypto";
import type { ChildConversationDeliveryV1 } from "./conversation.js";
import { canonicalDeliveryJsonV1 } from "../persistence/canonical.js";

const HEX64 = /^[0-9a-f]{64}$/u;
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`); return value as Record<string, unknown>; }
function string(value: unknown, label: string): string { if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > 512 || value.includes("\0")) throw new Error(`${label} is invalid`); return value; }
function text(value: unknown, label: string, maxBytes: number): string { if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes || value.includes("\0")) throw new Error(`${label} is invalid`); return value; }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`); return value as number; }
function fence(runtime: ChildEventPortV1, frame: ChildEventV1, envelope: Record<string, unknown>) { const eventId = string(envelope.eventId, "eventId"); const eventPayloadSha256 = string(envelope.eventPayloadSha256, "eventPayloadSha256"); if (!HEX64.test(eventPayloadSha256) || frame.eventSequence === undefined) throw new Error("owner event fence is invalid"); return { eventId, eventSequence: frame.eventSequence, eventPayloadSha256, runtimeGeneration: runtime.identity().runtimeGeneration }; }
async function persistAndAck(runtime: ChildEventPortV1, frame: ChildEventV1, type: string, payload: Readonly<Record<string, unknown>>): Promise<void> { const applied = await runtime.apply(type, payload); if (applied.result.persisted !== true) throw new Error("owner event application was not persisted"); const eventId = (frame.payload as Record<string, unknown>).eventId as string; const ack = await runtime.ack( { eventSequence: frame.eventSequence!, appliedEventIds: [eventId] }); if (ack.result.acked !== true && ack.result.persisted !== true) throw new Error("owner event ACK was not persisted"); }

export interface ChildEventV1 { readonly eventSequence: number; readonly payload: Readonly<Record<string, unknown>> }
export interface ChildEventPortV1 extends ChildConversationDeliveryV1 {
  identity(): { parentConversationSessionId: string; runtimeGeneration: number };
  apply(kind: string, payload: Readonly<Record<string, unknown>>): Promise<{ result: Readonly<Record<string, unknown>> }>;
  ack(payload: { eventSequence: number; appliedEventIds: string[] }): Promise<{ result: Readonly<Record<string, unknown>> }>;
  pendingRequestIds(): readonly string[];
}
export class ChildEventProcessorV1 {
  readonly runtime: ChildEventPortV1;
  #applications = new Map<string, { kind: string; payload: Readonly<Record<string, unknown>>; persisted: boolean }>();
  constructor(runtime: ChildEventPortV1) {
    this.runtime = { ...runtime,
      apply: async (kind, payload) => {
        const entry = { kind, payload, persisted: false }; this.#applications.set(String(payload.eventId), entry);
        const result = await runtime.apply(kind, payload); entry.persisted = result.result.persisted === true; return result;
      },
      ack: async payload => { const result = await runtime.ack(payload); if (result.result.acked === true || result.result.persisted === true) for (const id of payload.appliedEventIds) this.#applications.delete(id); return result; },
    };
  }
  async process(frame: ChildEventV1): Promise<void> {
    const envelope = object(frame.payload, "owner event envelope"); const keys = Object.keys(envelope).sort(); if (keys.join("\0") !== ["eventId", "eventKind", "eventPayloadSha256", "payload"].sort().join("\0")) throw new Error("owner event envelope has unknown or missing keys");
    const saved = this.#applications.get(String(envelope.eventId));
    if (saved) {
      const replay = fence(this.runtime, frame, envelope);
      if (Object.entries(replay).some(([key, value]) => saved.payload[key] !== value)) throw new Error("owner event replay fence changed");
      if (saved.persisted) {
        const ack = await this.runtime.ack({ eventSequence: replay.eventSequence, appliedEventIds: [replay.eventId] });
        if (ack.result.acked !== true && ack.result.persisted !== true) throw new Error("owner event ACK was not persisted");
      } else await persistAndAck(this.runtime, frame, saved.kind, saved.payload);
      if (saved.payload.kind === "settled_task_release_result") this.runtime.finalizeWakeProof(String(saved.payload.outboxId), Number(saved.payload.wakeEpoch));
      return;
    }
    const eventKind = string(envelope.eventKind, "eventKind"); const payload = object(envelope.payload, "owner event payload"); if (payload.kind !== eventKind) throw new Error("owner event kind mismatch"); const base = fence(this.runtime, frame, envelope);
    if (eventKind === "confirm_task_commit") {
      const taskId = string(payload.taskId, "taskId"); if (payload.logicalKey !== taskId) throw new Error("confirm task logical key mismatch"); const lease = this.runtime.taskLease(taskId); if (!lease) throw new Error("confirmed Task lease is absent");
      return persistAndAck(this.runtime, frame, "owner_event_application_result", { ...base, kind: "confirm_task_commit_result", taskId, logicalKey: taskId, lease });
    }
    if (eventKind === "acquire_task_lease") {
      const taskId = string(payload.taskId, "taskId"); if (payload.logicalKey !== taskId || payload.parentConversationSessionId !== this.runtime.identity().parentConversationSessionId) throw new Error("acquire Task lease identity mismatch"); const before = this.runtime.taskLease(taskId); const lease = this.runtime.acquireTaskLease(taskId);
      return persistAndAck(this.runtime, frame, "task_lease_acquired", { ...base, operationId: string(payload.operationId, "operationId"), taskId, logicalKey: taskId, state: before ? "already-acquired" : "acquired", lease });
    }
    if (eventKind === "release_task_lease") {
      const taskId = string(payload.taskId, "taskId"); if (payload.logicalKey !== taskId) throw new Error("release Task lease identity mismatch");
      if (payload.mode === "settled-task") { if (payload.wake !== true || !Array.isArray(payload.leaseReleases) || payload.leaseReleases.length < 1 || !Array.isArray(payload.completionIds) || payload.completionIds.length < 1 || !Array.isArray(payload.cardProofs) || payload.cardProofs.length !== payload.completionIds.length) throw new Error("settled Task release proof is invalid"); const outboxId = string(payload.outboxId, "outboxId"); const wakeEpoch = integer(payload.wakeEpoch, "wakeEpoch"); const releases = payload.leaseReleases.map((value, index) => { const release = object(value, `leaseReleases[${index}]`); return { taskId: string(release.taskId, "taskId"), outcome: release.outcome === "failed" ? "failed" as const : release.outcome === "cancelled" ? "cancelled" as const : "ready" as const }; }); if (releases.at(-1)!.taskId !== taskId) throw new Error("final Wake Task is not last release"); for (const release of releases.slice(0, -1)) this.runtime.releaseTaskLease(release.taskId, release.outcome); const settlement = await this.runtime.releaseTaskLeaseWithWake({ taskId, outcome: payload.leaseOutcome === "failed" ? "failed" : payload.leaseOutcome === "cancelled" ? "cancelled" : "ready", outboxId, wakeEpoch, completionIds: payload.completionIds.map((id, index) => string(id, `completionIds[${index}]`)) }); const applied = await this.runtime.apply("owner_event_application_result", { ...base, kind: "settled_task_release_result", taskId, logicalKey: taskId, outboxId, wakeEpoch, ...settlement }); if (applied.result.persisted !== true) throw new Error("settled Task Wake proof was not persisted"); this.runtime.finalizeWakeProof(outboxId, wakeEpoch); const ack = await this.runtime.ack( { eventSequence: frame.eventSequence!, appliedEventIds: [base.eventId] }); if (ack.result.acked !== true && ack.result.persisted !== true) throw new Error("owner event ACK was not persisted"); return; }
      if (payload.mode !== "abort-prepared") throw new Error("release Task mode is invalid");
      const bootstrap = this.runtime.identity(); let lease: { state: "released"; leaseId: string; generation: number } | { state: "source-generation-gone" };
      if (payload.sourceRuntimeGeneration === bootstrap.runtimeGeneration) { const released = this.runtime.releaseTaskLease(taskId, "cancelled"); lease = { state: "released", ...released }; }
      else lease = { state: "source-generation-gone" };
      return persistAndAck(this.runtime, frame, "prepared_lease_compensation_result", { ...base, kind: "prepared_lease_compensation_result", operationId: string(payload.operationId, "operationId"), taskId, logicalKey: taskId, sourceAgentId: string(payload.sourceAgentId, "sourceAgentId"), sourceRuntimeGeneration: integer(payload.sourceRuntimeGeneration, "sourceRuntimeGeneration"), lease });
    }
    if (eventKind === "mailbox_delivery") { if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 256 || !HEX64.test(string(payload.chunkSha256, "chunkSha256"))) throw new Error("mailbox delivery chunk is invalid"); const items = payload.items.map((value, index) => { const item = object(value, `mailbox item ${index}`); const bodySha256 = string(item.bodySha256, "bodySha256"); if (!HEX64.test(bodySha256) || createHash("sha256").update(text(item.body, "body", 65_536)).digest("hex") !== bodySha256) throw new Error("mailbox body proof mismatch"); const injected = object(item.injectedInto, "injectedInto"); const injectedInto = injected.kind === "task" ? { kind: "task" as const, taskId: string(injected.taskId, "taskId") } : injected.kind === "idle-conversation" ? { kind: "idle-conversation" as const } : (() => { throw new Error("mailbox injection target is invalid"); })(); return Object.freeze({ messageId: string(item.messageId, "messageId"), body: item.body as string, bodySha256, injectedInto, ...(typeof item.source === "string" ? { source: item.source } : {}) }); }); const chunk = createHash("sha256").update(canonicalDeliveryJsonV1(items)).digest("hex"); if (chunk !== payload.chunkSha256) throw new Error("mailbox chunk digest mismatch"); const proofs = await this.runtime.appendMailboxMessages(items); return persistAndAck(this.runtime, frame, "owner_event_application_result", { ...base, kind: "mailbox_delivery_result", chunkSha256: chunk, messageProofs: proofs }); }
    if (eventKind === "completion_delivery") {
      if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 256 || !HEX64.test(string(payload.windowIdentitySha256, "windowIdentitySha256")) || !HEX64.test(string(payload.chunkSha256, "chunkSha256"))) throw new Error("completion delivery window is invalid"); const items = payload.items.map((value, index) => { const item = object(value, `completion item ${index}`); const keys = Object.keys(item).sort().join("\0"); if (keys !== ["completionId", "content", "detailsJson", "inboxId", "projectionSha256"].sort().join("\0")) throw new Error("completion item shape is invalid"); const projectionSha256 = string(item.projectionSha256, "projectionSha256"); if (!HEX64.test(projectionSha256)) throw new Error("completion projection digest is invalid"); return Object.freeze({ inboxId: string(item.inboxId, "inboxId"), completionId: string(item.completionId, "completionId"), projectionSha256, content: text(item.content, "content", 71_680), detailsJson: text(item.detailsJson, "detailsJson", 71_680) }); }); const chunk = createHash("sha256").update(canonicalDeliveryJsonV1(items)).digest("hex"); if (chunk !== payload.chunkSha256) throw new Error("completion chunk digest mismatch"); const window = createHash("sha256").update(canonicalDeliveryJsonV1(items.map((item) => ({ inboxId: item.inboxId, projectionSha256: item.projectionSha256 })))).digest("hex"); if (window !== payload.windowIdentitySha256) throw new Error("completion window digest mismatch"); const proofs = await this.runtime.appendCompletionCards(items);
      return persistAndAck(this.runtime, frame, "owner_event_application_result", { ...base, kind: "completion_delivery_result", chunkSha256: chunk, cardProofs: proofs });
    }
    if (eventKind === "owner_health") {
      return persistAndAck(this.runtime, frame, "owner_event_application_result", { ...base, kind: "owner_health_result", ...(typeof payload.code === "string" ? { appliedCode: payload.code } : {}) });
    }
    if (eventKind === "prepare_shutdown") {
      if (payload.runtimeGeneration !== this.runtime.identity().runtimeGeneration) throw new Error("prepare shutdown generation mismatch");
      return persistAndAck(this.runtime, frame, "owner_event_application_result", { ...base, kind: "prepare_shutdown_result", activeLeaseTaskIds: this.runtime.activeLeaseTaskIds(), pendingOwnerRequestIds: this.runtime.pendingRequestIds(), state: "flushed" });
    }
    throw new Error(`owner event '${eventKind}' requires an unavailable delivery handler`);
  }
}
