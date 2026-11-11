/** Scheduler-owned mailbox DTO stand-in for final ACK recovery. */
import { createHash } from "node:crypto";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { Mail, MailboxDeliveryReceipt, MailboxSnapshot, TerminalEvidence } from "pi-session-inject/mailbox-v1";

export interface FulfilledFinalAckLostFixture {
  readonly injectionId: string;
  readonly taskId: string;
  readonly scheduledTime: number;
  readonly prompt: string;
  readonly contentDigest: string;
  readonly mail: Mail;
  readonly evidence: Extract<TerminalEvidence, { outcome: "fulfilled" }>;
  readonly snapshot: MailboxSnapshot;
  readonly sessionEntries: readonly FileEntry[];
  readonly sourceMarkerPhase: "mailbox-owned";
  readonly expected: { readonly newProviderRequests: 0; readonly nativeSends: 0; readonly terminalTransitions: 1 };
}

/** Paths/cwd are provided by the test's isolated directory, never daily HOME. */
export function fulfilledFinalAckLostFixture(sessionFile: string, cwd: string): FulfilledFinalAckLostFixture {
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const taskId = "mailbox-contract-fixture";
  const scheduledTime = 1800000000000;
  const injectionId = `${taskId}:${scheduledTime}`;
  const prompt = "Shared mailbox fixture: the scheduled result has already received a successful request opportunity.";
  const mail: Mail = {
    producer: "pi-scheduler", key: `injection:${injectionId}`, anchorEntryId: "anchor-fixture",
    policy: "new-run", wake: true,
    messages: [{ customType: "scheduler-injection-v1", content: prompt, display: true,
      details: { version: 1, injection_id: injectionId, task_id: taskId, title: "Shared ACK recovery fixture", scheduled_time: scheduledTime } }],
  };
  const evidence: FulfilledFinalAckLostFixture["evidence"] = {
    producer: mail.producer, key: mail.key, terminalId: "terminal-fulfilled-fixture",
    scope: { sessionId, anchorEntryId: mail.anchorEntryId }, outcome: "fulfilled",
    receiptEntryId: "delivery-fixture", assistantEntryId: "assistant-fixture", nativeEntryIds: ["native-injection-fixture"],
  };
  const { receiptEntryId: _receiptEntryId, ...diskEvidence } = evidence;
  const receipt: MailboxDeliveryReceipt = {
    version: 1, sessionId, terminals: [{ mail, branchEntryId: "native-injection-fixture", evidence: diskEvidence }],
  };
  const timestamp = "2026-10-24T00:00:00.000Z";
  const snapshot: MailboxSnapshot = {
    version: 1, session: { id: sessionId, file: sessionFile, cwd }, revision: 8, suspended: null, pending: [],
    terminal: [{
      mail, branchEntryId: "native-injection-fixture", evidence,
      requiredCallbacks: { recorded: true, terminal: true },
      recorded: { ack: "acknowledged", notice: { producer: mail.producer, key: mail.key, scope: evidence.scope,
        recordedToken: "recorded-injection-fixture", entries: [{ messageIndex: 0, entryId: "native-injection-fixture" }] } },
      terminalAck: "pending", backingReceiptEntryId: "delivery-fixture",
    }],
  };
  const sessionEntries: FileEntry[] = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd },
    { type: "message", id: "anchor-fixture", parentId: null, timestamp,
      message: { role: "user", content: "Fixture initial request", timestamp: Date.parse(timestamp) } },
    { type: "custom_message", id: "native-injection-fixture", parentId: "anchor-fixture", timestamp, ...mail.messages[0]! },
    { type: "message", id: "assistant-fixture", parentId: "native-injection-fixture", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "Fixture result recorded." }],
        api: "anthropic-messages", provider: "fixture", model: "faux", stopReason: "stop", timestamp: Date.parse(timestamp),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: "custom", customType: "agent-mailbox-delivery-v1", id: "delivery-fixture", parentId: "assistant-fixture", timestamp, data: receipt },
  ];
  return { injectionId, taskId, scheduledTime, prompt, contentDigest: createHash("sha256").update(prompt).digest("hex"),
    mail, evidence, snapshot, sessionEntries, sourceMarkerPhase: "mailbox-owned",
    expected: { newProviderRequests: 0, nativeSends: 0, terminalTransitions: 1 } };
}
