/** Compile-only producer integration fixture for the frozen public API. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  bindMailbox, type Mail, type MailboxSnapshot, type ProducerRegistration,
  type PutResult, type TerminalEvidence,
} from "../src/mailbox-v1/index.js";

const registration: ProducerRegistration = {
  id: "pi-scheduler",
  async checkCurrent(_mail, point, fence) {
    const scope: string = fence.session.id;
    const phase: "before-seal" | "before-native-send" = point;
    void scope; void phase;
    return { kind: "allow", project: true, wake: true };
  },
  proveNative: (_mail, _branch, _fence) => ({ kind: "observed", entries: [] }),
  async onRecorded(notice, fence) { void notice.recordedToken; void fence.producerToken; },
  onTerminal(evidence) {
    if (evidence.outcome === "fulfilled") void evidence.assistantEntryId;
    else void evidence.reason;
  },
  beforeRun(start) { void start.event.messageType; void start.members; void start.automatic; },
  afterRun(end) { const outcome: "completed" | "aborted" | "error" = end.outcome; void outcome; },
  async settled(event, ctx, fence) { void event.aborted; void ctx; void fence; },
};

async function producerIntegration(pi: ExtensionAPI, ctx: ExtensionContext): Promise<TerminalEvidence> {
  const binding = bindMailbox(pi);
  const endpoint = binding.registerProducer(registration);
  const target = endpoint.target(ctx);
  const mail: Mail = {
    producer: "pi-scheduler", key: "injection:test", anchorEntryId: null,
    policy: "new-run", wake: true,
    messages: [{
      customType: "scheduler-injection-v1", display: false,
      content: [{ type: "text", text: "job result" }, { type: "image", data: "YQ==", mimeType: "image/png" }],
      details: { injectionId: "test" },
    }],
  };
  const result: PutResult = await endpoint.put(mail, target);
  if (result.kind === "accepted") void result.revision;
  else { const terminal: "fulfilled" | "cancelled" = result.evidence.outcome; void terminal; }
  const terminal = await endpoint.cancel(mail.key, "source cancelled", target);
  endpoint.close(); binding.close();
  return terminal;
}
void producerIntegration;

const emptySnapshot: MailboxSnapshot = {
  version: 1, session: { id: "fixture", file: null }, revision: 0,
  suspended: null, pending: [], terminal: [],
};
void emptySnapshot;
// Producer IDs are open; registrations own their identity.
const invalidProducer: Mail["producer"] = "another-producer";
// @ts-expect-error No public five-state receipt / recorded terminal outcome.
const invalidOutcome: TerminalEvidence["outcome"] = "recorded";
void invalidProducer; void invalidOutcome;
