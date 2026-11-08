import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MailboxBinding, ProducerRegistration } from "pi-session-inject/mailbox-v1";
import { proveSubagentMail, type MailboxSubmit, type SubagentMailboxTransport } from "../../src/mailbox/transport.js";

/** A0 producer-side double only; never used by production or runtime gates. */
export function nativeMailboxDouble(session: ExtensionContext["sessionManager"], observe?: (message: any, options: { triggerTurn: boolean }) => void): SubagentMailboxTransport {
  const accepted = new Map<string, MailboxSubmit>();
  return { hasAccepted(key: string) { return accepted.has(key); }, async put(input: MailboxSubmit) {
    const mail = { ...input, producer: "pi-subagents" as const, policy: input.policy ?? "next-request" as const, anchorEntryId: null };
    if (!accepted.has(input.key)) {
      accepted.set(input.key, input);
      for (const message of input.messages) {
        if (!proveSubagentMail({ ...mail, messages: [message] }, session.getBranch()).length) {
          observe?.(message, { triggerTurn: input.wake });
          (session as any).appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        }
      }
    }
    return { result: { kind: "accepted" as const, key: input.key, revision: 1 }, mail, entries: proveSubagentMail(mail, session.getBranch()) };
  } } as SubagentMailboxTransport;
}
export function emptyMailboxBinding(): MailboxBinding {
  return { registerProducer(_registration: ProducerRegistration) {
    return { id: "pi-subagents", token: Symbol(), close() {}, async activateNewExecution() {},
      target() { throw new Error("test endpoint has no active session"); },
      async put() { throw new Error("unexpected test put"); }, async cancel() { throw new Error("unexpected test cancel"); },
      async importFulfilled() { throw new Error("unexpected legacy import"); },
    };
  }, close() {} };
}
