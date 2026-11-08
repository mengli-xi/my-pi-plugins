import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalJsonV1 } from "../persistence/canonical.js";
import type { ConversationRefV1 } from "../persistence/types.js";
import type { CompletionAppendProofV1, DeliveryAppendPortV1 } from "./delivery-engine.js";
import { DeliveryPending, type SubagentMailboxTransport } from "../mailbox/transport.js";

export function continuationDigest(content: string, details: unknown): string {
  return createHash("sha256").update(canonicalJsonV1({ custom_type: "subagent-continuation-v1", content, details })).digest("hex");
}
/** Main has no native sender: acceptance and exact proof both belong to mailbox. */
export class MainSessionAppendPortV1 implements DeliveryAppendPortV1 {
  readonly conversation: ConversationRefV1;
  readonly session: ExtensionContext["sessionManager"];
  readonly transport: SubagentMailboxTransport;
  constructor(session: ExtensionContext["sessionManager"], transport: SubagentMailboxTransport) {
    this.session = session; this.transport = transport;
    this.conversation = { kind: "main", session_id: session.getSessionId() };
  }
  async appendCompletion(input: Parameters<DeliveryAppendPortV1["appendCompletion"]>[0]): Promise<void> {
    const details = { version: 1, inbox_id: input.inboxId, completion_id: input.completionId,
      projection_sha256: input.projection.projection_sha256, details_json: input.projection.details_json };
    await this.transport.put({ key: `card:${input.inboxId}`, wake: false,
      messages: [{ customType: "subagent-completion-v1", content: input.projection.content, display: true, details }] });
  }
  async proveCompletion(input: Parameters<DeliveryAppendPortV1["proveCompletion"]>[0]): Promise<CompletionAppendProofV1> {
    const entries = this.session.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-completion-v1"
      && (entry.details as { inbox_id?: unknown })?.inbox_id === input.inboxId);
    const entry = entries[0];
    if (entries.length !== 1 || entry?.type !== "custom_message") throw new DeliveryPending();
    const details = entry.details as Record<string, unknown>;
    if (details.completion_id !== input.completionId || details.projection_sha256 !== input.projectionSha256) throw new Error("Main completion native identity mismatch");
    return { entryId: entry.id, completionId: input.completionId, projectionSha256: input.projectionSha256 };
  }
  async appendMailbox(input: { messageId: string; body: string; bodySha256: string; running: boolean }) {
    const accepted = await this.transport.put({ key: `mail:${input.messageId}`, wake: input.running,
      messages: [{ customType: "subagent-mailbox-v1", content: input.body, display: true,
        details: { message_id: input.messageId, body_sha256: input.bodySha256, injected_into: { kind: "idle-conversation" } } }] });
    const proof = accepted.entries[0];
    return proof ? { state: "injected" as const, entryId: proof.entryId } : { state: "pending" as const };
  }
  async acceptOutbox(input: Parameters<NonNullable<DeliveryAppendPortV1["acceptOutbox"]>>[0]): Promise<void> {
    await this.transport.put({ key: `outbox:${input.outboxId}:${input.wakeEpoch}`, wake: true,
      messages: input.inboxes.map(inbox => ({ customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
        details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } })) });
  }
  async acceptContinuation(input: Parameters<NonNullable<DeliveryAppendPortV1["appendContinuation"]>>[0]): Promise<void> {
    await this.transport.put({ key: `outbox:${input.outboxId}:${input.wakeEpoch}:continuation`, wake: true,
      messages: [{ customType: "subagent-continuation-v1", content: input.content, display: false, details: input.details }] });
  }
  hasAcceptedContinuation(input: { outboxId: string; wakeEpoch: number }): boolean {
    return this.transport.hasAccepted(`outbox:${input.outboxId}:${input.wakeEpoch}:continuation`);
  }
  async appendContinuation(input: Parameters<NonNullable<DeliveryAppendPortV1["appendContinuation"]>>[0]): Promise<void> {
    await this.acceptContinuation(input);
  }
  async findContinuation(input: { outboxId: string; wakeEpoch: number }) {
    const entries = this.session.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1"
      && (entry.details as Record<string, unknown>)?.outbox_id === input.outboxId && (entry.details as Record<string, unknown>)?.wake_epoch === input.wakeEpoch);
    if (entries.length > 1) throw new Error("duplicate Main continuation");
    const entry = entries[0];
    if (entry?.type !== "custom_message") return undefined;
    return { entryId: entry.id, wakeEpoch: input.wakeEpoch, continuationSha256: continuationDigest(entry.content as string, entry.details) };
  }
  async proveContinuation(input: Parameters<NonNullable<DeliveryAppendPortV1["proveContinuation"]>>[0]) {
    const proof = await this.findContinuation(input);
    if (!proof) throw new DeliveryPending();
    if (proof.continuationSha256 !== input.continuationSha256) throw new Error("Main continuation hash mismatch");
    return proof;
  }
}
