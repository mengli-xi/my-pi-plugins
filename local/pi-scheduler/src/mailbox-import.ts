/** Legacy native carrier reader. Only the active branch supplies processing proof. */
import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MailboxTarget, ProducerEndpoint } from "pi-session-inject/mailbox-v1";
import { INJECTION_TYPE, injectionMail, nativeInjectionProof, type SchedulerSend } from "./mailbox-adapter.ts";
import type { MailboxInjectionOffer } from "./protocol.ts";

export async function importSchedulerBranch(options: {
  branch: readonly SessionEntry[];
  offers: readonly MailboxInjectionOffer[];
  unknownIds?: ReadonlySet<string>;
  endpoint: ProducerEndpoint;
  target: MailboxTarget;
  send: SchedulerSend;
  diagnostic: (message: string) => void;
}): Promise<Set<string>> {
  const imported = new Set<string>();
  const seen = new Set<string>();
  for (const [index, entry] of options.branch.entries()) {
    if (entry.type !== "custom_message" || entry.customType !== INJECTION_TYPE) continue;
    const d = entry.details as Record<string, unknown> | undefined;
    const id = d?.injection_id;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    if (options.unknownIds?.has(id)) continue;
    if (d?.version !== 1 || typeof d.task_id !== "string" || typeof d.title !== "string" ||
        typeof d.scheduled_time !== "number" || id !== `${d.task_id}:${d.scheduled_time}` || typeof entry.content !== "string") {
      options.diagnostic(`Scheduler legacy injection ${id}: invalid frozen carrier; unknown.`);
      continue;
    }
    const offer = options.offers.find((o) => o.injectionId === id);
    if (offer && !offer.legacy) continue;
    if (!offer) {
      const history = await options.send({ type: "task.runs", id: d.task_id });
      if (!history.ok || history.type !== "runs") throw new Error("scheduler legacy history unavailable");
      const run = history.runs.find((r) => r.injectionId === id);
      if (run?.detail === "mailbox-fulfilled" || run?.detail?.startsWith("mailbox-cancelled:")) continue;
      if (run?.outcome !== "delivered") {
        options.diagnostic(`Scheduler legacy injection ${id}: daemon delivery receipt unavailable; unknown.`);
        continue;
      }
      const origin = await options.send({ type: "injection.current", injectionId: id, sessionId: options.target.session.id });
      if (!origin.ok || origin.type !== "injection-current" || !origin.legacyDelivered) {
        options.diagnostic(`Scheduler legacy injection ${id}: original source session unavailable; unknown.`);
        continue;
      }
    }
    const mail = offer ? injectionMail(offer) : injectionMail({ injectionId: id, taskId: d.task_id, title: d.title,
      scheduledTime: d.scheduled_time, prompt: entry.content, contentDigest: createHash("sha256").update(entry.content).digest("hex"),
      // Completed imports do not consult staleAt. Never reuse this to run work.
      staleAt: 0, anchorEntryId: entry.parentId });
    const proof = nativeInjectionProof(mail, options.branch);
    if (proof.kind === "conflict") { options.diagnostic(`Scheduler legacy injection ${id}: ${proof.reason}; unknown.`); continue; }
    const assistant = options.branch.slice(index + 1).find((e) => e.type === "message" && e.message.role === "assistant" &&
      e.message.stopReason === "stop");
    if (!assistant) {
      if (!offer) options.diagnostic(`Scheduler legacy injection ${id}: frozen daemon intent unavailable; unknown.`);
      continue;
    }
    await options.endpoint.importFulfilled(mail, { sourceReceiptEntryId: entry.id, assistantEntryId: assistant.id }, options.target);
    imported.add(id);
  }
  return imported;
}
