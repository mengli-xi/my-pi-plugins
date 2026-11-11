import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mail, ProducerRegistration, ProducerEndpoint } from "pi-session-inject/mailbox-v1";
import { defaultProcessesConfig } from "../../src/config.ts";
import { ProcessHost, type HostTransport, type TransportCallbacks } from "../../src/host/process-host.ts";
import { MainTurnNotificationCoordinatorV1 } from "../../src/notifications/main-turn.ts";
import { createNotificationBrokerV1 } from "../../src/notifications/broker.ts";
import type { NotificationBrokerLimitsV1 } from "../../src/notifications/types.ts";
import { ProcessMailboxSourceV1 } from "../../src/notifications/mailbox-source.ts";
import { proveProcessMailV1 } from "../../src/notifications/mailbox-proof.ts";

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Transport implements HostTransport {
  supervisorPid = 42; hostNonce = "a".repeat(64); generation = 1; closed = false;
  async request(type: string) { return type === "spawn" ? { pid: 100, pgid: 100, stdinOpen: true, logRevision: 0, watchRevision: 0 } : { ok: true }; }
  async cleanup() { return { unresolved: 0 }; }
  async waitForExit() {} terminate() {} close() { this.closed = true; }
}

export async function mailboxHarness(config = defaultProcessesConfig(), limits?: Partial<NotificationBrokerLimitsV1>) {
  const sessionId = `mailbox-${crypto.randomUUID()}`;
  const root: any[] = [{ id: "origin", parentId: null, type: "message", message: { role: "user", content: "start" } }];
  let branch = root, idle = false, markerFault = false;
  const entries = new Map<string, any>();
  const allEntries = () => { for (const entry of branch) entries.set(entry.id, entry); return [...entries.values()]; };
  let callbacks!: TransportCallbacks, registration!: ProducerRegistration;
  const host = new ProcessHost({ sessionScopeId: sessionId, launch: async value => { callbacks = value; return new Transport(); }, ...(limits ? { notificationBroker: createNotificationBrokerV1({ sessionScopeId: sessionId, limits }) } : {}) });
  const puts: Mail[] = [], accepted = new Map<string, Mail>(), imports: any[] = [], reports: string[] = [];
  const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => sessionId, getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch, getEntries: allEntries } } as unknown as ExtensionContext;
  let currentContext = ctx;
  const pi = {
    appendEntry(customType: string, data: any) {
      if (markerFault && data.state === "pending") throw new Error("FAULT marker");
      branch.push({ type: "custom", id: crypto.randomUUID(), parentId: branch.at(-1)?.id ?? null, customType, data });
    },
    sendMessage() { assert.fail("Processes must never submit native messages"); },
  };
  let coordinator!: MainTurnNotificationCoordinatorV1;
  const token = Symbol("producer"), target = { slotKey: sessionId, session: { id: sessionId, file: "/tmp/fixture.jsonl" }, bindingGeneration: 1, producerToken: token };
  const endpoint: ProducerEndpoint = {
    id: "pi-processes", token, target: () => target,
    async activateNewExecution() { assert.fail("Processes does not own execution activation"); },
    async put(mail, captured) {
      assert.equal(captured, target);
      const previous = accepted.get(mail.key);
      if (previous) assert.deepEqual(mail, previous);
      else { accepted.set(mail.key, structuredClone(mail)); puts.push(structuredClone(mail)); }
      return { kind: "accepted", key: mail.key, revision: puts.length };
    },
    async cancel(key, reason) { return { producer: "pi-processes", key, terminalId: `cancel:${key}`, scope: { sessionId, anchorEntryId: accepted.get(key)?.anchorEntryId ?? null }, outcome: "cancelled", reason }; },
    async importFulfilled(mail, proof) {
      imports.push({ mail, proof });
      return { producer: "pi-processes", key: mail.key, terminalId: `terminal:${mail.key}`, scope: { sessionId, anchorEntryId: mail.anchorEntryId }, outcome: "fulfilled", receiptEntryId: "receipt", assistantEntryId: proof.assistantEntryId, nativeEntryIds: [] };
    }, close() {},
  };
  const source = new ProcessMailboxSourceV1({ pi: pi as any, agentDir: "/tmp/fixture-agent", getContext: () => currentContext,
    callbacks: {
      checkCurrent: mail => coordinator.checkCurrent(mail), onRecorded: notice => coordinator.recorded(notice), onTerminal: evidence => coordinator.terminal(evidence),
      beforeRun: start => coordinator.beforeRun(start), afterRun: end => coordinator.afterRun(end), settled: event => coordinator.agentSettled(event.aborted),
    },
    bind: () => ({ registerProducer(value) { registration = value; return endpoint; }, close() {} }),
  });
  const make = () => new MainTurnNotificationCoordinatorV1({ sessionScopeId: sessionId, host, pi: pi as any, mailbox: source, getContext: () => currentContext, report: message => reports.push(message) });
  coordinator = make(); coordinator.activate(ctx);
  const bind = () => host.bind({ deliver(_event, delivery) { if (delivery?.modelLane === "turn") return coordinator.accept(); }, appendNotificationEntry(entry) { pi.appendEntry(entry.customType, entry.data); } });
  let binding = bind(); await binding.markReady();
  const record = await host.start({ action: "start", name: "watcher", kind: "monitor", command: "true", watches: [{ key: "ready", pattern: "READY", mode: "literal", stream: "stdout", repeat: true, attention: "turn" }], continuation: { mode: "wait", until: { kind: "watch", key: "ready" } } }, config, process.cwd());
  let eventSequence = 0;
  const fence = { ...target, ownerEpoch: 1, attemptId: null };
  return {
    host, source, pi, ctx, registration, puts, imports, reports, accepted, root, sessionId,
    replaceContext(value: ExtensionContext) { currentContext = value; },
    get coordinator() { return coordinator; }, get branch() { return branch; }, setBranch(value: any[]) { allEntries(); branch = value; coordinator.rebranch(value); },
    replaceSessionEntries(value: any[]) { entries.clear(); branch = value; coordinator.rebranch(value); },
    setIdle(value: boolean) { idle = value; }, markerFault(value: boolean) { markerFault = value; },
    async match() { eventSequence++; callbacks.onEvent({ type: "watchMatch", eventSequence, payload: { id: record.id, key: "ready", generation: 1, sequence: eventSequence, text: "READY" } }); await tick(); },
    async terminal(classification = "natural") { callbacks.onEvent({ type: "terminal", eventSequence: ++eventSequence, payload: { id: record.id, classification, exitCode: classification === "natural" ? 0 : null, signal: classification === "timeout" ? "SIGTERM" : null, ...(classification === "timeout" ? { timeoutMs: 1000 } : {}) } }); await tick(); },
    async matcherError(code = "matcher-startup-timeout") { callbacks.onEvent({ type: "matcherError", eventSequence: ++eventSequence, payload: { id: record.id, key: "ready", generation: 1, sequence: eventSequence, code } }); await tick(); },
    async rearm() { await host.configure({ action: "configure", target: record.id, continuation: { mode: "wait", until: { kind: "watch", key: "ready" } } }); },
    async record(mail = puts.at(-1)!) {
      if (!branch.some(e => e.type === "custom_message" && e.details?.batchId === mail.key.slice(6))) branch.push({ id: crypto.randomUUID(), parentId: branch.at(-1)?.id, type: "custom_message", ...mail.messages[0] });
      const proof = proveProcessMailV1(mail, branch, sessionId); assert.equal(proof.kind, "observed");
      if (proof.kind !== "observed") return;
      await registration.onRecorded!({ producer: "pi-processes", key: mail.key, scope: { sessionId, anchorEntryId: mail.anchorEntryId }, recordedToken: mail.key, entries: proof.entries }, fence);
    },
    async beforeRun() { await registration.beforeRun!({ ctx, fence, event: { messageType: "user" } as any, automatic: false, members: [] }); },
    async end(keys = puts.map(m => m.key), outcome: "completed" | "aborted" | "error" = "completed") {
      const assistant = { id: crypto.randomUUID(), type: "message", message: { role: "assistant", stopReason: outcome === "completed" ? "stop" : outcome, content: [] } };
      branch.push(assistant); idle = true;
      coordinator.afterRun({ ctx, fence, event: { type: "agent_end", messages: [] }, outcome, assistantEntryId: assistant.id, members: keys.map(key => ({ mail: accepted.get(key)!, entries: [] })) });
      await coordinator.agentSettled(outcome === "aborted");
    },
    async reload() { coordinator.dispose(); await binding.retire("reload"); coordinator = make(); coordinator.activate(ctx); binding = bind(); await binding.markReady(); await coordinator.importLegacy(ctx, source); },
    async dispose() { coordinator.dispose(); source.close(); await binding.retire("scope-ended"); },
  };
}
