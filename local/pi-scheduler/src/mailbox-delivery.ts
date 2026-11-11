import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Mail, MailboxTarget, ProducerEndpoint, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import { nativeInjectionProof } from "./mailbox-adapter.ts";

export interface SchedulerDeliveryIntent { readonly mail: Mail; readonly target: MailboxTarget; readonly recovered: boolean }

/** Called only after the original source has durably acknowledged this terminal. */
export function forgetSchedulerIntent(intents: Map<string, SchedulerDeliveryIntent>, evidence: TerminalEvidence): void {
  const intent = intents.get(evidence.key);
  if (intent?.mail.producer === evidence.producer && intent.target.session.id === evidence.scope.sessionId &&
      intent.mail.anchorEntryId === evidence.scope.anchorEntryId) intents.delete(evidence.key);
}

/** A tree may invalidate an unaccepted async put even at a shared ancestor.
 * Retain its old target/intent until the source origin is positively restored.
 * The caller captures target before IPC. A new generation is adopted only
 * after the source origin has been positively rebuilt. */
export async function putSchedulerIntent(options: {
  endpoint: ProducerEndpoint;
  target: MailboxTarget;
  mail: Mail;
  recovered: boolean;
  intents: Map<string, SchedulerDeliveryIntent>;
  branch: readonly SessionEntry[];
  leafId: string | null;
}) {
  let intent = options.intents.get(options.mail.key);
  if (intent && !isDeepStrictEqual(intent.mail, options.mail)) throw new Error("scheduler frozen delivery intent changed");
  if (!intent || intent.target.bindingGeneration !== options.target.bindingGeneration) {
    const native = nativeInjectionProof(options.mail, options.branch);
    if (native.kind === "conflict") return { kind: "held" as const, reason: native.reason };
    const origin = options.leafId === options.mail.anchorEntryId || native.entries.length === options.mail.messages.length;
    if (!origin) return { kind: "held" as const, reason: "scheduler origin is not confirmed after scope change" };
    intent = { mail: options.mail, target: options.target, recovered: intent?.recovered ?? options.recovered };
    options.intents.set(options.mail.key, intent);
  }
  return intent.recovered
    ? options.endpoint.put(intent.mail, intent.target, { recovered: true })
    : options.endpoint.put(intent.mail, intent.target);
}
