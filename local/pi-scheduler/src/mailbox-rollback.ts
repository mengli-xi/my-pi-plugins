/** Offline rollback projection. CLI holds the daemon's kernel advisory lock. */
import { closeSync, cpSync, existsSync, fsyncSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { assertInjectionReceiptMatchesMarker } from "./mailbox-identity.ts";
import { legacyInjectionIdentity, SchedulerStore } from "./store.ts";

export function schedulerRollbackInventory(root: string) {
  const store = new SchedulerStore(root);
  const receipts = store.listInjectionReceipts();
  const legacyReceipts = store.listLegacyInjectionReceipts();
  const markers = store.listInjections();
  for (const legacy of legacyReceipts) {
    if (receipts.some((r) => r.evidence.key === legacyInjectionIdentity(legacy).key)) throw new Error("receipt-marker-conflict: duplicate terminal identity; unknown");
  }
  for (const marker of markers) {
    const receipt = receipts.find((r) => r.marker.injectionId === marker.injectionId) ??
      legacyReceipts.find((r) => legacyInjectionIdentity(r).key === `injection:${marker.injectionId}`);
    if (receipt) assertInjectionReceiptMatchesMarker(marker, receipt);
  }
  const incompleteLegacy = legacyReceipts.filter(r => !r.evidence).map(r => ({ injectionId: legacyInjectionIdentity(r).key.slice(10),
    taskId: null, sessionId: legacyInjectionIdentity(r).scope.sessionId, phase: "legacy-recorded", mailbox: true,
    reason: "legacy recorded ACK awaits original terminal evidence" }));
  return [...incompleteLegacy, ...markers.filter((m) => (m.phase !== "settled" || m.terminalOutcome !== "failure" || m.mailbox) && !store.getInjectionReceipt(m.injectionId)).map((m) => ({
    injectionId: m.injectionId, taskId: m.taskId, sessionId: m.sessionId,
    phase: m.phase, mailbox: !!m.mailbox, reason: "unfinished delivery",
  }))];
}

export function normalizeSchedulerRollback(options: { root: string; archiveDir: string; abandonIds: readonly string[] }) {
  const root = resolve(options.root);
  const archive = resolve(options.archiveDir);
  const relation = relative(root, archive);
  if (!relation || (!relation.startsWith("..") && !isAbsolute(relation))) throw new Error("archive must be outside scheduler store");
  if (existsSync(archive)) throw new Error("archive already exists");
  const store = new SchedulerStore(root);
  const blockers = schedulerRollbackInventory(root);
  if (store.listLegacyInjectionReceipts().some(r => !r.evidence)) throw new Error("rollback refused: legacy recorded ACK requires original terminal evidence; unknown");
  const requested = new Set(options.abandonIds);
  if (requested.size !== options.abandonIds.length) throw new Error("duplicate abandonment identity");
  const missing = blockers.filter((m) => !requested.has(m.injectionId));
  const unknown = [...requested].filter((id) => !blockers.some((m) => m.injectionId === id));
  if (missing.length || unknown.length) throw new Error(`rollback refused: ${JSON.stringify({ missing, unknown })}`);
  // Preserve original bytes before the first active-store mutation.
  cpSync(root, archive, { recursive: true, errorOnExist: true, force: false });
  syncArchive(archive);
  const audit = [];
  const markers = new Map(store.listInjections().map((m) => [m.injectionId, m]));
  for (const receipt of store.listInjectionReceipts()) {
    if (!markers.has(receipt.marker.injectionId)) markers.set(receipt.marker.injectionId, receipt.marker);
  }
  for (const marker of markers.values()) {
    const { mailbox: _mailbox, createdForHolder: _createdForHolder, ...legacy } = marker;
    if (marker.phase === "settled" && marker.terminalOutcome === "failure" && !marker.mailbox) {
      if (marker.createdForHolder) store.putInjection(legacy);
      continue;
    }
    const completed = store.getInjectionReceipt(marker.injectionId);
    const outcome = completed?.evidence.outcome === "fulfilled" ? "delivered" : "failure";
    const detail = completed ? (outcome === "delivered" ? "mailbox-fulfilled" : `mailbox-cancelled:${completed.evidence.outcome === "cancelled" ? completed.evidence.reason : ""}`)
      : "user-abandoned delivery";
    const finishedAt = completed?.finishedAt ?? Date.now();
    store.putInjection({ ...legacy, phase: "settled", terminalOutcome: outcome,
      terminalDetail: detail, leaseToken: undefined, leaseExpiresAt: undefined });
    if (!completed?.runRecorded && !store.listRuns(marker.taskId).some((r) => r.injectionId === marker.injectionId && (completed || r.detail === detail))) {
      store.appendRun({ taskId: marker.taskId, scheduledTime: marker.scheduledTime, finishedAt,
        injectionId: marker.injectionId, target: "session", outcome, detail, ...(outcome === "failure" ? { acknowledged: false } : {}) });
    }
    const task = store.getTask(marker.taskId);
    if (task && (task.lastScheduledTime ?? -Infinity) < marker.scheduledTime) {
      store.putTask({ ...task, lastScheduledTime: marker.scheduledTime });
    }
    store.clearInjection(marker.injectionId);
    audit.push({ injectionId: marker.injectionId, disposition: detail });
  }
  for (const receipt of store.listLegacyInjectionReceipts()) {
    audit.push({ injectionId: legacyInjectionIdentity(receipt).key.slice(10), disposition: "legacy-mailbox-fulfilled" });
  }
  // Completed source receipts are backed by old-schema run records. The full
  // mailbox receipt bytes stay in the archive, outside the active old store.
  rmSync(resolve(root, "mailbox-receipts"), { recursive: true, force: true });
  writeFileSync(resolve(archive, "mailbox-rollback-audit.json"), `${JSON.stringify({ version: 1, audit }, null, 2)}\n`, { mode: 0o600 });
  syncArchive(archive);
  return audit;
}

function syncArchive(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) syncArchive(child);
    else if (entry.isFile()) {
      const fd = openSync(child, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
