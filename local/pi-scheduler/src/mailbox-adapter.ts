import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Mail, MailboxCallbackFence, ProducerRegistration, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import type { MailboxInjectionOffer, SchedulerRequest, SchedulerResponse } from "./protocol.ts";

export const INJECTION_TYPE = "scheduler-injection-v1";
export const injectionKey = (injectionId: string): string => `injection:${injectionId}`;
function sameJson(a: unknown, b: unknown): boolean {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : v;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
export type SchedulerSend = (request: SchedulerRequest) => Promise<SchedulerResponse>;

export function injectionMail(offer: MailboxInjectionOffer): Mail {
  if (createHash("sha256").update(offer.prompt).digest("hex") !== offer.contentDigest) {
    throw new Error("scheduler injection prompt digest mismatch");
  }
  return { producer: "pi-scheduler", key: injectionKey(offer.injectionId), anchorEntryId: offer.anchorEntryId,
    policy: "new-run", wake: true, messages: [{ customType: INJECTION_TYPE, content: offer.prompt, display: true,
      details: { version: 1, injection_id: offer.injectionId, task_id: offer.taskId,
        title: offer.title, scheduled_time: offer.scheduledTime } }] };
}

function injectionId(mail: Pick<Mail, "key">): string {
  if (!mail.key.startsWith("injection:") || mail.key.length === 10) throw new Error("invalid scheduler injection key");
  return mail.key.slice(10);
}

export function nativeInjectionProof(mail: Mail, branch: readonly SessionEntry[]) {
  const id = injectionId(mail);
  const carrier = mail.messages[0];
  if (mail.messages.length !== 1 || carrier.customType !== INJECTION_TYPE || typeof carrier.content !== "string") {
    throw new Error("invalid scheduler carrier");
  }
  const matches = branch.filter((entry) => entry.type === "custom_message" && entry.customType === INJECTION_TYPE &&
    (entry.details as { injection_id?: unknown } | undefined)?.injection_id === id);
  if (matches.length > 1) return { kind: "conflict" as const, reason: "duplicate scheduler native identity" };
  if (!matches.length) return { kind: "observed" as const, entries: [] };
  const entry = matches[0]!;
  if (entry.type !== "custom_message" || entry.content !== carrier.content ||
      !sameJson(entry.details, carrier.details)) {
    return { kind: "conflict" as const, reason: "scheduler native content/details conflict" };
  }
  return { kind: "observed" as const, entries: [{ messageIndex: 0, entryId: entry.id }] };
}

async function acknowledged(send: SchedulerSend, request: SchedulerRequest): Promise<void> {
  const response = await send(request);
  if (!response.ok || response.type !== "ack") throw new Error(response.ok ? "invalid scheduler ACK" : response.error);
}

export function schedulerProducer(send: SchedulerSend,
    cancel?: (key: string, reason: string, fence: MailboxCallbackFence) => Promise<unknown>,
    currentBranch?: (sessionId: string) => readonly SessionEntry[] | undefined,
    onTerminalAcknowledged?: (evidence: TerminalEvidence) => void): ProducerRegistration {
  return {
    id: "pi-scheduler",
    async checkCurrent(mail, _point, fence) {
      const response = await send({ type: "injection.current", injectionId: injectionId(mail), sessionId: fence.session.id });
      if (!response.ok || response.type !== "injection-current" || !response.marker?.mailbox) {
        return { kind: "hold", reason: "scheduler source unavailable or unknown" };
      }
      const marker = response.marker;
      const expected = injectionMail({ ...marker, contentDigest: createHash("sha256").update(marker.prompt).digest("hex"),
        anchorEntryId: marker.mailbox!.anchorEntryId });
      if (!sameJson(mail, expected)) return { kind: "hold", reason: "scheduler source identity conflict" };
      if (marker.mailbox!.legacy) {
        const branch = currentBranch?.(fence.session.id);
        const proof = branch && nativeInjectionProof(mail, branch);
        const entry = proof?.kind === "observed" && branch?.find((e) => e.id === proof.entries[0]?.entryId);
        if (!entry || entry.id !== marker.mailbox!.entryId || entry.parentId !== marker.mailbox!.anchorEntryId) {
          return { kind: "hold", reason: "scheduler legacy carrier/scope unavailable; unknown" };
        }
      }
      if (marker.mailbox!.failureReason) return { kind: "cancel", reason: marker.mailbox!.failureReason };
      if (marker.mailbox!.startedAt === undefined && response.now > marker.staleAt) {
        return { kind: "cancel", reason: "injection-stale" };
      }
      return { kind: "allow", project: true, wake: true };
    },
    async proveNative(mail, branch, fence) {
      const proof = nativeInjectionProof(mail, branch);
      if (proof.kind === "conflict") return proof;
      const current = await send({ type: "injection.current", injectionId: injectionId(mail), sessionId: fence.session.id });
      if (current.ok && current.type === "injection-current" && current.legacyDelivered && proof.entries.length === mail.messages.length) return proof;
      if (!current.ok || current.type !== "injection-current" || !current.marker?.mailbox) {
        return { kind: "conflict", reason: "scheduler original source proof unavailable; unknown" };
      }
      const original = current.marker.mailbox;
      if (original.legacy) {
        const entry = branch.find((e) => e.id === proof.entries[0]?.entryId);
        if (proof.entries.length !== 1 || entry?.id !== original.entryId || entry?.parentId !== original.anchorEntryId) {
          return { kind: "conflict", reason: "scheduler legacy carrier/scope unavailable; unknown" };
        }
      }
      return proof;
    },
    async onRecorded(notice, fence) {
      if (notice.entries.length !== 1 || notice.entries[0]?.messageIndex !== 0) throw new Error("incomplete scheduler native proof");
      await acknowledged(send, { type: "injection.handoff", injectionId: injectionId(notice), sessionId: fence.session.id,
        recordedToken: notice.recordedToken, entryId: notice.entries[0].entryId, anchorEntryId: notice.scope.anchorEntryId });
    },
    async onTerminal(evidence) {
      await acknowledged(send, { type: "injection.terminal", evidence });
      onTerminalAcknowledged?.(evidence);
    },
    async afterRun(end) {
      if (end.outcome === "completed") return;
      for (const member of end.members) {
        await acknowledged(send, { type: "injection.failed", injectionId: injectionId(member.mail),
          sessionId: end.fence.session.id, outcome: end.outcome });
        if (!cancel) throw new Error("Scheduler cancellation endpoint unavailable");
        await cancel(member.mail.key, `run-${end.outcome}`, end.fence);
      }
    },
    async beforeRun(start) {
      // Only the real run marks start; ACK replay never fabricates this hook.
      for (const member of start.members) {
        const response = await send({ type: "injection.start", injectionId: injectionId(member.mail), sessionId: start.fence.session.id });
        // The following source guard performs the durable cancellation.
        if (!response.ok && response.error === "injection-stale") continue;
        if (!response.ok) throw new Error(response.error);
      }
    },
  };
}
