import type { Mail, MailboxBinding, MailboxCallbackFence, ProducerRegistration } from "pi-session-inject/mailbox-v1";

/** Source-only Goal/lease contract driver, not A1 durability or delivery proof.
 * The real A1/stock B/C/D gates live in test/real/mailbox-{joint,triple}-e2e.
 * Goal now queues custom mail and receives actual-run callbacks rather than
 * sending a user continuation. Keep old source tests on that public contract.
 */
export function goalMailboxSourceDouble(transcript: {
  getSessionId(): string; getLeafId(): string | null; getSessionFile(): string;
  appendCustomMessageEntry(type: string, content: string, display: boolean, details: unknown): string;
}) {
  let callbacks!: ProducerRegistration;
  const token = Symbol("source-test"), mails = new Map<string, { mail: Mail; entryId: string }>();
  const fence = (): MailboxCallbackFence => ({ slotKey: JSON.stringify(["source-test", transcript.getSessionId()]), session: { id: transcript.getSessionId(), file: transcript.getSessionFile() }, producerToken: token, bindingGeneration: 1, ownerEpoch: 1, attemptId: "source-test" });
  const binding: MailboxBinding = { registerProducer(registration) {
    callbacks = registration;
    return { id: registration.id, token, target: () => fence(), close() {}, async activateNewExecution() {},
      async put(mail) {
        const decision = callbacks.checkCurrent(mail, "before-native-send", fence());
        if ("then" in decision) throw new Error("source-only Goal driver requires its synchronous guard");
        if (decision.kind === "allow" && decision.project && !mails.has(mail.key)) {
          const message = mail.messages[0]!;
          const entryId = transcript.appendCustomMessageEntry(message.customType, String(message.content), message.display, message.details);
          mails.set(mail.key, { mail, entryId });
        }
        return { kind: "accepted", key: mail.key, revision: 1 };
      },
      async cancel(key, reason) { return { producer: registration.id, key, terminalId: `cancel:${key}`, scope: { sessionId: transcript.getSessionId(), anchorEntryId: mails.get(key)?.mail.anchorEntryId ?? null }, outcome: "cancelled", reason }; },
      async importFulfilled() { throw new Error("source-only driver does not emulate legacy fulfillment"); },
    };
  }, close() {} };
  return { binding, texts: () => [...mails.values()].map(item => String(item.mail.messages[0]!.content)),
    async settled(ctx: unknown) { await callbacks.settled?.({ type: "agent_settled", aborted: false } as never, ctx as never, fence()); },
    async start(ctx: unknown) {
      const item = [...mails.values()].at(-1); if (!item) throw new Error("no queued Goal custom mail");
      await callbacks.beforeRun?.({ event: { type: "before_agent_start", messageType: "custom", message: { role: "custom", customType: "agent-mailbox-trigger-v1", content: "Source-test actual run", display: false, timestamp: 1 } } as never,
        ctx: ctx as never, fence: fence(), automatic: true, members: [{ mail: item.mail, entries: [{ messageIndex: 0, entryId: item.entryId }] }] });
    },
  };
}
