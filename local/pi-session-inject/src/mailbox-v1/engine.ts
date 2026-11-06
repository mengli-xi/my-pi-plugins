import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  SessionStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  MailboxCommandFacade,
  BindMailboxOptions,
  CurrentDecision,
  LegacyFulfilledProof,
  LiveSubmitted,
  Mail,
  MailboxBinding,
  MailboxCallbackFence,
  MailboxCommandRouter,
  MailboxDeliveryOwner,
  MailboxHolder,
  MailboxRecoveryTarget,
  MailboxRunMember,
  MailboxSessionIdentity,
  MailboxSessionSlot,
  MailboxSnapshot,
  MailboxTarget,
  NativeEntryRef,
  PendingRecord,
  ProducerEndpoint,
  ProducerRegistration,
  PutResult,
  RecordedNotification,
  TerminalEvidence,
  TerminalRecord,
} from "./types.js";
import type { Slot, Hub, Registrar } from "./runtime.js";
import { SlotState, diagnostic, type Registration } from "./slot-state.js";
import { createMailboxCommandFacade } from "./commands.js";
import { checkpoint } from "./checkpoint.js";
import { MailboxError } from "./errors.js";
import { SlotStorage } from "./storage.js";
import { appendDelivery, nativeEquals, onBranch, readDiskSession, terminalIndex, verifyLegacyRequest, verifyNative } from "./proof.js";
import { bodyKey, cloneJson, frozenMail, mailOnly, recordKey, same, sameMail } from "./validation.js";
import { MAILBOX_CUSTOM_TYPES } from "./constants.js";
export { MAILBOX_ABI_VERSION as version, MAILBOX_TRANSPORT_BUILD_ID as transportBuildId } from "./constants.js";
export { releaseDiskSession } from "./proof.js";
const TRIGGER_TEXT =
  "Automated background mailbox delivery, not a user message. Do not treat it as user approval, confirmation, or a reply to any pending question.";
const PARTICIPANT_MS = 5_000;
type Member = { registration: Registration; record: PendingRecord; decision: Extract<CurrentDecision, { kind: "allow" }> };

async function bounded<T>(operation: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mailbox participant exceeded 5s")), PARTICIPANT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function trigger(value: unknown, sessionId: string): string | null {
  const message = value as { customType?: string; details?: { version?: number; sessionId?: string; attemptId?: string } } | null;
  return message?.customType === MAILBOX_CUSTOM_TYPES.trigger &&
    message.details?.version === 1 &&
    message.details.sessionId === sessionId &&
    typeof message.details.attemptId === "string"
    ? message.details.attemptId
    : null;
}

/** Cold methods act on the existing slot; these are our own objects, never Pi prototypes. */
export class DeliverySlot extends SlotState {
  newStorage(): SlotStorage {
    return new SlotStorage(this.agentDir, this.session, (snapshot) => this.observeDiskPending(snapshot));
  }
  observeDiskPending(snapshot: MailboxSnapshot): void {
    if (this.recoveryReleased) return;
    const terminal = new Set(snapshot.terminal.map((record) => recordKey(record.mail)));
    for (const record of snapshot.pending) {
      const key = recordKey(record);
      const local = this.liveAccepted.get(key);
      if (!terminal.has(key) && (!local || !sameMail(local, record))) this.recoveryHeldKeys.add(key);
    }
  }
  releaseRecovery(): void {
    this.recoveryReleased = true;
    this.recoveryHeldKeys.clear();
  }
  held(mail: Pick<Mail, "producer" | "key">): boolean {
    return this.recoveryHeldKeys.has(recordKey(mail));
  }
  liveRecord(registration: Registration, fence: MailboxCallbackFence, mail: Mail): PendingRecord | undefined {
    if (!this.validFence(registration, fence) || this.snapshot.suspended || this.compacting || this.held(mail)) return;
    const key = recordKey(mail),
      record = this.snapshot.pending.find((item) => recordKey(item) === key);
    if (
      !record ||
      record.legacyImport ||
      this.failedIngress.has(key) ||
      this.snapshot.terminal.some((item) => recordKey(item.mail) === key) ||
      !sameMail(record, mail) ||
      !onBranch(record, record.branchEntryId, this.sessionManager.getBranch())
    )
      return;
    return record;
  }
  async block(error: unknown): Promise<void> {
    diagnostic(this.owner?.ctx ?? null, error);
    try {
      await this.store.transact((draft) => {
        draft.suspended = { reason: "blocked", detail: String(error) };
      });
    } catch {
      /* keep original snapshot; never erase accepted intent on IO failure */
    }
  }
  async rebuild(): Promise<void> {
    const runnable = new Set(this.snapshot.pending.map(recordKey));
    for (const key of this.sourceErrors.keys()) if (!runnable.has(key)) this.sourceErrors.delete(key);
    for (const key of this.proofErrors.keys()) if (!runnable.has(key)) this.proofErrors.delete(key);
    if (!this.snapshot.pending.length && !this.snapshot.terminal.length) return;
    const index = terminalIndex(await readDiskSession(this.session), this.session.id);
    for (const terminal of this.snapshot.terminal) {
      const persisted = index.get(recordKey(terminal.mail));
      if (
        (persisted && (!same(persisted.evidence, terminal.evidence) || !sameMail(persisted.mail, terminal.mail))) ||
        (terminal.evidence.outcome === "fulfilled" && !persisted)
      )
        throw new MailboxError("unverifiable-proof", "terminal snapshot evidence is missing or contradicts disk receipt");
    }
    const rebuilt = await this.store.transact((draft) => {
      let changed = false;
      for (const pending of [...draft.pending]) {
        const old = index.get(recordKey(pending));
        if (!old) continue;
        if (!sameMail(pending, old.mail)) throw new MailboxError("unverifiable-proof", "disk terminal conflicts with pending identity");
        if (pending.legacyImport && pending.legacyImport.evidence.terminalId !== old.evidence.terminalId)
          throw new MailboxError("unverifiable-proof", "legacy import receipt conflicts with durable intent");
        if (!draft.terminal.some((record) => recordKey(record.mail) === recordKey(pending)))
          draft.terminal.push({
            ...old,
            requiredCallbacks: pending.requiredCallbacks,
            recorded:
              old.evidence.outcome === "cancelled" && pending.recorded?.ack === "pending"
                ? { ...pending.recorded, ack: "superseded-by-cancel" }
                : pending.recorded,
            terminalAck: pending.requiredCallbacks.terminal ? "pending" : "acknowledged",
          });
        draft.pending = draft.pending.filter((record) => recordKey(record) !== recordKey(pending));
        changed = true;
      }
      return changed;
    });
    if (rebuilt) this.scheduleNotices();
  }
  schedule(): void {
    if (!this.current()) return;
    if (this.critical || this.draining || this.compacting) {
      this.scheduleRequested = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduleRequested = false;
    const epoch = this.ownerEpoch,
      generation = this.bindingGeneration;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      if (!this.current(undefined, epoch, generation)) return;
      void this.ready
        .then(async () => {
          await this.reconcileProofs();
          if (this.owner?.ctx.isIdle()) await this.drain("idle");
        })
        .catch((error) => this.block(error));
    });
  }
  scheduleNotices(): void {
    if (this.noticesScheduled || this.critical || !this.current()) return;
    this.noticesScheduled = setImmediate(() => {
      this.noticesScheduled = null;
      if (this.critical || !this.current()) return;
      for (const registration of this.registrations)
        if (!registration.closed && (registration.binding.current as SlotState | null) === this) {
          void this.replay(registration).catch((error) => diagnostic(this.owner?.ctx ?? null, error));
        }
    });
  }
  async cutoff(): Promise<number> {
    const upper = this.ingress;
    await Promise.allSettled([...this.incoming].filter(([seq]) => seq <= upper).map(([, promise]) => promise));
    return upper;
  }
  async selected(mode: "active" | "idle" | "run", upper: number, point: "before-seal" | "before-native-send"): Promise<Member[]> {
    if (!this.current() || this.snapshot.suspended || this.compacting) return [];
    const branch = this.sessionManager.getBranch(),
      members: Member[] = [];
    for (const record of this.snapshot.pending) {
      if (this.held(record) || record.legacyImport || (mode !== "run" && this.run?.request.has(recordKey(record)))) continue;
      if (
        this.failedIngress.has(recordKey(record)) ||
        (this.acceptedSequence.get(recordKey(record)) ?? 0) > upper ||
        !onBranch(record, record.branchEntryId, branch)
      )
        continue;
      if (this.snapshot.terminal.some((terminal) => recordKey(terminal.mail) === recordKey(record))) continue;
      if (this.run?.heldSources.has(record.producer)) continue;
      if (
        (mode === "active" && record.policy !== "next-request") ||
        (mode === "idle" && (record.policy === "next-user" || (record.policy === "new-run" && !record.wake)))
      )
        continue;
      if (mode === "run" && record.policy === "next-user" && !this.acceptedUser) continue;
      const registration = this.registration(record.producer);
      if (!registration) continue;
      const fence = this.fence(registration);
      let decision: CurrentDecision;
      try {
        decision = await bounded(() => registration.callbacks.checkCurrent(mailOnly(record), point, fence));
      } catch (error) {
        this.sourceErrors.set(recordKey(record), String(error));
        diagnostic(registration.binding.ctx, error);
        continue;
      }
      if (!this.liveRecord(registration, fence, record)) continue;
      if (decision.kind === "cancel") {
        await this.cancel(registration, record.key, decision.reason, fence);
        continue;
      }
      if (decision.kind === "allow" && decision.project) {
        this.sourceErrors.delete(recordKey(record));
        try {
          await this.prove(record, registration);
        } catch {
          continue;
        }
        const current = this.liveRecord(registration, fence, record);
        if (current && !this.proofErrors.has(recordKey(record))) members.push({ registration, record: current, decision });
      } else this.sourceErrors.set(recordKey(record), decision.kind === "hold" ? decision.reason : "mailbox projection withheld");
    }
    return members;
  }
  async beforeRun(event: BeforeAgentStartEvent): Promise<void> {
    const epoch = this.ownerEpoch,
      generation = this.bindingGeneration;
    const control = event.messageType === "custom" ? trigger(event.message, this.session.id) : null;
    const idle = control && this.submitted.idleControls.get(control);
    if (idle) this.submitted.idleControls.set(control!, { ...idle, start: { boundary: "before_agent_start" } });
    this.acceptedUser = event.messageType === "user" && this.inputCandidate === "external";
    if (event.messageType === "user") this.inputCandidate = "empty";
    if (this.acceptedUser) {
      this.releaseRecovery();
      if (this.snapshot.suspended)
        await this.store.transact((draft) => {
          draft.suspended = null;
        });
      this.failedIngress.clear();
    }
    ++this.runOrdinal;
    this.run = {
      controls: new Set(idle ? [control!] : []),
      observed: new Map(),
      request: new Map(),
      heldSources: new Set(),
      assistantEntryId: null,
      outcome: "completed",
    };
    const initial = await this.selected("run", await this.cutoff(), "before-seal");
    if (!this.current(undefined, epoch, generation)) return;
    for (const registration of this.registrations) {
      if (registration.closed || (registration.binding.current as SlotState | null) !== this || !registration.callbacks.beforeRun) continue;
      const fence = this.fence(registration, control);
      try {
        await bounded(() =>
          registration.callbacks.beforeRun!({
            event,
            ctx: this.owner!.ctx,
            fence,
            automatic: !!idle,
            members: initial
              .filter((member) => member.registration === registration)
              .map((member) => ({ mail: mailOnly(member.record), entries: member.record.nativeEntries })),
          }),
        );
      } catch (error) {
        if (this.current(undefined, epoch, generation)) this.run?.heldSources.add(registration.callbacks.id);
        diagnostic(registration.binding.ctx, error);
      }
      if (!this.validFence(registration, fence)) return;
    }
    const members = await this.selected("run", await this.cutoff(), "before-seal");
    if (!this.current(undefined, epoch, generation)) return;
    if (members.length || control) await this.seal(control ?? randomUUID(), members);
    await this.sendBodies(members);
  }
  controlStarted(value: unknown, boundary: "message_start" | "message_end"): void {
    if (!this.current()) return;
    const id = trigger(value, this.session.id);
    if (!id) return;
    const active = this.submitted.activeControls.get(id);
    if (active) {
      this.submitted.activeControls.set(id, { ...active, start: { boundary } });
      this.run?.controls.add(id);
    }
  }
  async seal(id: string, members: Member[]): Promise<void> {
    const scope = members.map(({ record }) => ({ producer: record.producer, key: record.key, anchorEntryId: record.anchorEntryId }));
    await this.store.transact((draft) => {
      draft.attempt = { id, members: scope, sealedRevision: draft.revision + 1 };
    });
    this.owner!.pi.appendEntry(MAILBOX_CUSTOM_TYPES.attempt, { version: 1, sessionId: this.session.id, ...this.snapshot.attempt });
  }
  async drain(mode: "active" | "idle", deferControl = false): Promise<void> {
    if (this.draining || !this.current() || this.snapshot.suspended || this.compacting) return;
    this.draining = true;
    const epoch = this.ownerEpoch,
      generation = this.bindingGeneration;
    try {
      const upper = await this.cutoff();
      const members = await this.selected(mode, upper, "before-seal");
      if (!this.current(undefined, epoch, generation)) return;
      const outstanding = this.submitted.activeControls.size + this.submitted.idleControls.size > 0;
      // Readiness can depend on native proof/onRecorded (Processes). Append
      // project=true bodies even when its effective wake guard is still false.
      await this.sendBodies(mode === "active" ? members : members.filter((member) => !member.decision.wake || !member.record.wake));
      if (deferControl) return;
      // Native proof/source readiness may have changed during append. Recheck
      // permissions before committing an irrevocable automatic control.
      const original = new Set(members.map((member) => recordKey(member.record)));
      const currentMembers = (await this.selected(mode, upper, "before-seal")).filter((member) => original.has(recordKey(member.record)));
      if (
        !currentMembers.some((member) => member.record.wake && member.decision.wake) ||
        outstanding ||
        !this.current(undefined, epoch, generation)
      )
        return;
      const id = randomUUID();
      if (mode === "active") await this.seal(id, currentMembers);
      const finalMembers = currentMembers.filter(
        (member) =>
          this.liveRecord(member.registration, this.fence(member.registration), member.record) &&
          !this.run?.request.has(recordKey(member.record)) &&
          !this.proofErrors.has(recordKey(member.record)),
      );
      if (!finalMembers.some((member) => member.record.wake && member.decision.wake) || !this.current(undefined, epoch, generation)) return;
      const registration = finalMembers[0]!.registration;
      const details = { version: 1 as const, sessionId: this.session.id, attemptId: id };
      const submission = { details, submittedBy: this.fence(registration, id), start: null, nativeEntryId: null };
      checkpoint("before-control");
      if (
        !this.current(undefined, epoch, generation) ||
        !finalMembers.some(
          (member) =>
            member.record.wake &&
            member.decision.wake &&
            !this.run?.request.has(recordKey(member.record)) &&
            this.liveRecord(member.registration, this.fence(member.registration), member.record),
        )
      )
        return;
      if (mode === "active") this.submitted.activeControls.set(id, submission);
      else this.submitted.idleControls.set(id, submission);
      this.owner!.pi.sendMessage(
        { customType: MAILBOX_CUSTOM_TYPES.trigger, content: TRIGGER_TEXT, display: false, details },
        { triggerTurn: true, deliverAs: "steer" },
      );
      checkpoint("after-control");
    } finally {
      this.draining = false;
      if (this.scheduleRequested) this.schedule();
    }
  }
  async prove(record: PendingRecord, registration: Registration): Promise<readonly NativeEntryRef[]> {
    const key = recordKey(record),
      fence = this.fence(registration);
    const flightKey = JSON.stringify([key, registration.token.description, fence.ownerEpoch, fence.bindingGeneration]);
    const previous = this.proofFlights.get(flightKey);
    if (previous) return previous;
    const flight = this.proveCurrent(record, registration).then(
      (entries) => {
        if (this.validFence(registration, fence)) this.proofErrors.delete(key);
        return entries;
      },
      (error) => {
        if (this.validFence(registration, fence)) {
          this.proofErrors.set(key, String(error));
          diagnostic(registration.binding.ctx, error);
        }
        throw error;
      },
    );
    this.proofFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.proofFlights.get(flightKey) === flight) this.proofFlights.delete(flightKey);
    }
  }
  async proveCurrent(record: PendingRecord, registration: Registration): Promise<readonly NativeEntryRef[]> {
    const fence = this.fence(registration),
      branch = this.sessionManager.getBranch();
    const proof = await bounded(() => registration.callbacks.proveNative(mailOnly(record), branch, fence));
    const currentRecord = this.snapshot.pending.find((item) => recordKey(item) === recordKey(record));
    if (
      !this.validFence(registration, fence) ||
      !currentRecord ||
      !sameMail(currentRecord, record) ||
      this.snapshot.terminal.some((item) => recordKey(item.mail) === recordKey(record)) ||
      !onBranch(currentRecord, currentRecord.branchEntryId, this.sessionManager.getBranch())
    )
      return [];
    if (proof.kind === "conflict") throw new MailboxError("conflict", proof.reason);
    const found = new Map<number, NativeEntryRef>(record.nativeEntries.map((entry) => [entry.messageIndex, entry]));
    for (const entry of proof.entries) {
      const previous = found.get(entry.messageIndex);
      if (previous && previous.entryId !== entry.entryId)
        throw new MailboxError("unverifiable-proof", "native proof changed for accepted mail");
      found.set(entry.messageIndex, entry);
    }
    const entries = [...found.values()].sort((a, b) => a.messageIndex - b.messageIndex);
    verifyNative(record, entries, this.sessionManager.getBranch());
    for (const entry of entries) {
      const key = bodyKey(record, entry.messageIndex),
        live = this.submitted.falseBodies.get(key);
      if (live) this.submitted.falseBodies.set(key, { ...live, nativeEntryId: entry.entryId });
    }
    if (!same(entries, record.nativeEntries) || (entries.length === record.messages.length && !record.recorded)) {
      const recorded = await this.store.transact((draft) => {
        const index = draft.pending.findIndex((item) => recordKey(item) === recordKey(record));
        if (index < 0 || draft.terminal.some((item) => recordKey(item.mail) === recordKey(record))) return;
        const current = draft.pending[index]!;
        const recorded: RecordedNotification | null =
          current.recorded ??
          (entries.length === current.messages.length
            ? {
                notice: {
                  producer: current.producer,
                  key: current.key,
                  scope: { sessionId: this.session.id, anchorEntryId: current.anchorEntryId },
                  recordedToken: randomUUID(),
                  entries,
                },
                ack: current.requiredCallbacks.recorded ? "pending" : "acknowledged",
              }
            : null);
        draft.pending[index] = {
          ...current,
          nativeEntries: entries,
          branchEntryId: entries[0]?.entryId ?? current.branchEntryId,
          recorded,
        };
        return !current.recorded && recorded !== null;
      });
      if (recorded) this.scheduleNotices();
    }
    return entries;
  }
  async reconcileProofs(): Promise<void> {
    if (!this.current()) return;
    await this.rebuild();
    for (const record of this.snapshot.pending)
      if (record.legacyImport) {
        try {
          await this.terminalOperation(() => this.finishLegacyImport(record));
        } catch (error) {
          this.proofErrors.set(recordKey(record), String(error));
          diagnostic(this.owner?.ctx ?? null, error);
        }
      }
    for (const record of this.snapshot.pending) {
      if (record.legacyImport) continue;
      if (!onBranch(record, record.branchEntryId, this.sessionManager.getBranch())) continue;
      const registration = this.registration(record.producer);
      if (!registration) continue;
      try {
        await this.prove(record, registration);
      } catch {
        /* proofErrors is independent from ordinary guard errors */
      }
    }
  }
  async sendBodies(members: Member[]): Promise<void> {
    for (const member of members) {
      const { registration } = member,
        key = recordKey(member.record);
      const record = this.snapshot.pending.find((item) => recordKey(item) === key);
      if (!record || this.held(record) || this.snapshot.terminal.some((item) => recordKey(item.mail) === key)) continue;
      const fence = this.fence(registration);
      let decision: CurrentDecision;
      try {
        decision = await bounded(() => registration.callbacks.checkCurrent(mailOnly(record), "before-native-send", fence));
      } catch (error) {
        this.sourceErrors.set(key, String(error));
        continue;
      }
      if (!this.liveRecord(registration, fence, record)) continue;
      if (decision.kind === "cancel") {
        await this.cancel(registration, record.key, decision.reason, fence);
        continue;
      }
      if (decision.kind !== "allow" || !decision.project) continue;
      let entries: readonly NativeEntryRef[];
      try {
        entries = await this.prove(record, registration);
      } catch {
        continue;
      }
      if (!this.liveRecord(registration, fence, record) || this.proofErrors.has(key)) continue;
      for (const [index, message] of record.messages.entries()) {
        if (!this.liveRecord(registration, fence, record)) break;
        if (entries.some((entry) => entry.messageIndex === index) || this.submitted.falseBodies.has(bodyKey(record, index))) continue;
        checkpoint("before-body");
        if (!this.liveRecord(registration, fence, record)) break;
        this.submitted.falseBodies.set(bodyKey(record, index), {
          producer: record.producer,
          key: record.key,
          messageIndex: index,
          scope: { sessionId: this.session.id, anchorEntryId: record.anchorEntryId },
          submittedBy: fence,
          nativeEntryId: null,
        });
        try {
          this.owner!.pi.sendMessage(cloneJson(message), { triggerTurn: false, deliverAs: "steer" });
          checkpoint("after-body");
        } catch (error) {
          await this.block(error);
          break;
        }
      }
    }
    await this.reconcileProofs();
  }
  async project(event: ContextEvent): Promise<ContextEvent["messages"]> {
    const epoch = this.ownerEpoch, generation = this.bindingGeneration;
    await this.reconcileProofs();
    const messages = [...event.messages];
    // Request-local evidence only: every projection reruns guards, never caches authority.
    const admitted = new Map<string, { record: PendingRecord; registration: Registration; fence: MailboxCallbackFence }>();
    for (const record of this.snapshot.pending) {
      if (
        this.held(record) ||
        record.legacyImport ||
        this.proofErrors.has(recordKey(record)) ||
        record.nativeEntries.length !== record.messages.length ||
        !onBranch(record, record.branchEntryId, this.sessionManager.getBranch())
      )
        continue;
      const registration = this.registration(record.producer);
      if (!registration || this.run?.heldSources.has(record.producer)) continue;
      const fence = this.fence(registration);
      let decision: CurrentDecision;
      try {
        decision = await bounded(() => registration.callbacks.checkCurrent(mailOnly(record), "before-native-send", fence));
      } catch (error) {
        this.sourceErrors.set(recordKey(record), String(error));
        diagnostic(registration.binding.ctx, error);
        continue;
      }
      if (!this.liveRecord(registration, fence, record) || this.proofErrors.has(recordKey(record))) continue;
      if (decision.kind === "cancel") {
        await this.cancel(registration, record.key, decision.reason, fence);
        continue;
      }
      if (decision.kind !== "allow" || !decision.project) {
        this.sourceErrors.set(recordKey(record), decision.kind === "hold" ? decision.reason : "mailbox projection withheld");
        continue;
      }
      this.sourceErrors.delete(recordKey(record));
      admitted.set(recordKey(record), { record, registration, fence });
      for (const carrier of record.messages) {
        if (!messages.some((message) => this.messageMatches(message, carrier)))
          messages.push({ role: "custom", ...cloneJson(carrier), timestamp: Date.now() });
      }
    }
    // Cancelled carriers can remain in native history after their pending body
    // and acknowledged tombstone have been GC'd. Disk receipts retain that
    // authority in the original session, including when the source is disabled.
    // Read after producer awaits, and retry if a concurrent cancel/GC changed the
    // snapshot while reading: neither side of the receipt → snapshot handoff
    // may disappear from this projection. The final filter is synchronous.
    for (;;) {
      const snapshot = this.snapshot;
      const disk = await readDiskSession(this.session);
      if (!this.current(undefined, epoch, generation)) throw new MailboxError("stale-binding", "mailbox projection binding changed");
      if (this.session.file && !disk && this.sessionManager.getEntries().some(entry => entry.type === "custom"
        && entry.customType === MAILBOX_CUSTOM_TYPES.delivery && (entry.data as { sessionId?: unknown } | undefined)?.sessionId === this.session.id))
        throw new MailboxError("unverifiable-proof", "mailbox projection lost the original delivery receipts");
      const index = terminalIndex(disk, this.session.id);
      if (snapshot !== this.snapshot) continue;
      // Several keys may share one canonical native carrier (e.g. a Completion
      // card and its Outbox). A terminal overrides only its own pending key;
      // cancellation must not hide another key's live or fulfilled reference.
      const terminals = new Map(
        [...snapshot.terminal, ...index.values()]
          .filter((record) => record.evidence.scope.sessionId === this.session.id)
          .map((record) => [recordKey(record.mail), record]),
      );
      const cancelledCarriers = [...terminals.values()]
        .filter((record) => record.evidence.outcome === "cancelled")
        .flatMap((record) => [...record.mail.messages]);
      const fulfilledCarriers = [...terminals.values()]
        .filter((record) => record.evidence.outcome === "fulfilled")
        .flatMap((record) => [...record.mail.messages]);
      const allowed = (record: PendingRecord) => {
        const entry = admitted.get(recordKey(record));
        return !!entry && !this.run?.heldSources.has(record.producer) && !this.proofErrors.has(recordKey(record))
          && !!this.liveRecord(entry.registration, entry.fence, entry.record);
      };
      const pending = snapshot.pending.filter(record => !terminals.has(recordKey(record)));
      const retainedCarriers = [...pending.filter(allowed).flatMap(record => [...record.messages]), ...fulfilledCarriers];
      const blockedCarriers = [...pending.filter(record => !allowed(record)).flatMap(record => [...record.messages]), ...cancelledCarriers];
      return messages.filter(message => !blockedCarriers.some(carrier => this.messageMatches(message, carrier))
        || retainedCarriers.some(carrier => this.messageMatches(message, carrier)));
    }
  }
  messageMatches(value: unknown, carrier: Mail["messages"][number]): boolean {
    const message = value as { role?: string; customType?: string; content?: unknown; display?: boolean; details?: unknown };
    return (
      message.role === "custom" &&
      message.customType === carrier.customType &&
      same(message.content, carrier.content) &&
      same(message.details, carrier.details) &&
      message.display === carrier.display
    );
  }
  async observe(event: ContextWithSystemEvent): Promise<void> {
    if (!this.run) return;
    const request = new Map<string, MailboxRunMember>();
    for (const record of this.snapshot.pending) {
      if (
        this.held(record) ||
        record.legacyImport ||
        this.proofErrors.has(recordKey(record)) ||
        this.sourceErrors.has(recordKey(record)) ||
        this.failedIngress.has(recordKey(record)) ||
        this.run.heldSources.has(record.producer) ||
        !this.registration(record.producer) ||
        record.nativeEntries.length !== record.messages.length ||
        !onBranch(record, record.branchEntryId, this.sessionManager.getBranch())
      )
        continue;
      if (record.messages.every((carrier) => event.messages.some((message) => this.messageMatches(message, carrier)))) {
        const member = { mail: mailOnly(record), entries: record.nativeEntries };
        request.set(recordKey(record), member);
        this.run.observed.set(recordKey(record), member);
      } else await this.block(new Error(`context filtered active mail ${record.producer}/${record.key}`));
    }
    this.run.request = request;
    if (request.size) checkpoint("request-observed");
  }
  terminalOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.terminalTail.then(operation);
    this.terminalTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async fulfill(event: TurnEndEvent): Promise<void> {
    if (
      !this.run ||
      event.message.role !== "assistant" ||
      event.message.stopReason === "error" ||
      event.message.stopReason === "aborted" ||
      event.outcome !== "completed"
    )
      return;
    if (this.run.request.size) checkpoint("request-success");
    this.run.assistantEntryId = event.messageEntryId;
    for (const [key, member] of this.run.request) {
      const record = this.snapshot.pending.find((item) => recordKey(item) === key);
      const registration = record && this.registration(record.producer);
      if (!record || this.held(record) || this.proofErrors.has(key) || !registration || this.run.heldSources.has(record.producer)) continue;
      const fence = this.fence(registration);
      let decision: CurrentDecision;
      try {
        decision = await bounded(() => registration.callbacks.checkCurrent(mailOnly(record), "before-seal", fence));
      } catch {
        continue;
      }
      if (!this.validFence(registration, fence)) continue;
      if (decision.kind === "cancel") {
        await this.cancel(registration, record.key, decision.reason, fence);
        continue;
      }
      if (decision.kind !== "allow" || !decision.project) continue;
      await this.terminalOperation(async () => {
        const current = this.snapshot.pending.find((item) => recordKey(item) === key);
        if (!current || this.snapshot.terminal.some((item) => recordKey(item.mail) === key) || !this.validFence(registration, fence))
          return;
        const existing = terminalIndex(await readDiskSession(this.session), this.session.id).get(key);
        const evidence = existing?.evidence ?? {
          producer: record.producer,
          key: record.key,
          terminalId: randomUUID(),
          scope: { sessionId: this.session.id, anchorEntryId: record.anchorEntryId },
          outcome: "fulfilled" as const,
          assistantEntryId: event.messageEntryId,
          nativeEntryIds: member.entries.map((entry) => entry.entryId),
        };
        const indexed =
          existing ??
          (await appendDelivery(this.owner!.pi, this.owner!.ctx, this.session, {
            mail: mailOnly(record),
            branchEntryId: current.branchEntryId,
            evidence,
          }));
        if (!indexed) return; // memory-only receipt is not permission to delete pending
        checkpoint("before-terminal");
        await this.store.transact((draft) => {
          const old = draft.pending.find((item) => recordKey(item) === key);
          if (!old || draft.terminal.some((item) => recordKey(item.mail) === key)) return;
          draft.terminal.push({
            ...indexed,
            requiredCallbacks: old.requiredCallbacks,
            recorded: old.recorded,
            terminalAck: old.requiredCallbacks.terminal ? "pending" : "acknowledged",
          });
          draft.pending = draft.pending.filter((item) => recordKey(item) !== key);
        });
        checkpoint("after-terminal");
      });
    }
  }
  async afterRun(event: AgentEndEvent): Promise<void> {
    if (!this.run) return;
    const epoch = this.ownerEpoch,
      generation = this.bindingGeneration;
    const run = this.run;
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    run.outcome =
      this.owner!.ctx.signal?.aborted || last?.stopReason === "aborted"
        ? "aborted"
        : !last || last.stopReason === "error"
          ? "error"
          : "completed";
    for (const registration of this.registrations) {
      if (!this.current(undefined, epoch, generation)) return;
      if (registration.closed || (registration.binding.current as SlotState | null) !== this || !registration.callbacks.afterRun) continue;
      try {
        await bounded(() =>
          registration.callbacks.afterRun!({
            event,
            ctx: this.owner!.ctx,
            fence: this.fence(registration),
            outcome: run.outcome,
            members: [...run.observed.values()].filter((member) => member.mail.producer === registration.callbacks.id),
            assistantEntryId: run.assistantEntryId,
          }),
        );
      } catch (error) {
        diagnostic(registration.binding.ctx, error);
      }
    }
  }
  async settled(event: AgentSettledEvent): Promise<void> {
    const epoch = this.ownerEpoch,
      generation = this.bindingGeneration;
    const run = this.run;
    if ((event.aborted || run?.outcome === "error") && (this.snapshot.pending.length || this.snapshot.attempt))
      await this.store.transact((draft) => {
        draft.suspended = {
          reason: event.aborted ? "aborted" : "error",
          detail: "Automatic transport suspended; accepted user input or /mailbox resume required",
        };
      });
    if (run) {
      for (const id of run.controls) {
        if (this.submitted.activeControls.get(id)?.start) this.submitted.activeControls.delete(id);
        if (this.submitted.idleControls.get(id)?.start) this.submitted.idleControls.delete(id);
      }
      const attemptId = this.snapshot.attempt?.id;
      if (attemptId && !this.submitted.activeControls.has(attemptId) && !this.submitted.idleControls.has(attemptId))
        await this.store.transact((draft) => {
          if (draft.attempt?.id === attemptId) delete draft.attempt;
        });
    }
    this.run = null;
    this.acceptedUser = false;
    await this.reconcileProofs();
    for (const registration of this.registrations) {
      if (!this.current(undefined, epoch, generation)) return;
      if (registration.closed || (registration.binding.current as SlotState | null) !== this || !registration.callbacks.settled) continue;
      try {
        await bounded(() => registration.callbacks.settled!(event, this.owner!.ctx, this.fence(registration)));
      } catch (error) {
        diagnostic(registration.binding.ctx, error);
      }
      if (!this.current(undefined, epoch, generation)) return;
      await this.drain("idle");
    }
    await this.drain("idle");
  }
  async beforeNavigation(tree = false): Promise<{ cancel?: boolean }> {
    const generation = this.bindingGeneration;
    await this.cutoff();
    await this.terminalTail;
    await this.store.barrier();
    if (
      [...this.submitted.falseBodies.values()].some((body) => !body.nativeEntryId) ||
      [...this.submitted.activeControls.values(), ...this.submitted.idleControls.values()].some((control) => !control.start)
    ) {
      diagnostic(
        this.owner!.ctx,
        "Cannot leave: native mailbox submission is unconfirmed; reconcile in a fresh process if it never starts",
      );
      return { cancel: true };
    }
    const unbound = this.snapshot.pending.filter(
      (record) => record.nativeEntries.length === 0 && onBranch(record, record.branchEntryId, this.sessionManager.getBranch()),
    );
    if (!tree && !unbound.length && !this.snapshot.pending.length) return {};
    const disk = await readDiskSession(this.session);
    if ((tree || unbound.length) && !disk) {
      diagnostic(this.owner!.ctx, "Cannot leave: mailbox origin has no persisted session history yet");
      return { cancel: true };
    }
    if (tree || unbound.length) {
      const id = randomUUID();
      this.owner!.pi.appendEntry(MAILBOX_CUSTOM_TYPES.attempt, {
        version: 1,
        sessionId: this.session.id,
        id,
        members: unbound.map((record) => ({ producer: record.producer, key: record.key, anchorEntryId: record.anchorEntryId })),
        sealedRevision: this.snapshot.revision,
      });
      const anchor = this.sessionManager.getLeafId();
      const refreshed = await readDiskSession(this.session);
      if (!anchor || !refreshed?.byId.has(anchor)) {
        diagnostic(this.owner!.ctx, "Cannot leave: mailbox origin anchor is not persisted yet");
        return { cancel: true };
      }
      if (tree) this.admissionAnchors.set(generation, anchor);
      await this.store.transact((draft) => {
        draft.pending = draft.pending.map((record) =>
          record.nativeEntries.length === 0 && onBranch(record, record.branchEntryId, this.sessionManager.getBranch())
            ? { ...record, branchEntryId: anchor }
            : record,
        );
      });
    }
    if (this.snapshot.pending.some((record) => record.anchorEntryId !== null && !disk?.byId.has(record.anchorEntryId))) {
      diagnostic(this.owner!.ctx, "Cannot leave: accepted mailbox origin is absent from session disk");
      return { cancel: true };
    }
    return {};
  }
  async put(registration: Registration, mail: Mail, target: MailboxTarget, seq: number, recovered: boolean): Promise<PutResult> {
    mail = frozenMail(mail);
    await this.ready;
    this.assertTarget(registration, target);
    if (!this.session.file) throw new MailboxError("not-ready", "durable mailbox requires a persistent session/recovery location");
    if (mail.producer !== registration.callbacks.id) throw new MailboxError("conflict", "mailbox endpoint producer mismatch");
    const branch = this.sessionManager.getBranch();
    const index = terminalIndex(await readDiskSession(this.session), this.session.id);
    const key = recordKey(mail),
      diskTerminal = index.get(key);
    const result = await this.store.transact<PutResult>((draft) => {
      const terminal = draft.terminal.find((record) => recordKey(record.mail) === key) ?? diskTerminal;
      if (terminal) {
        if (!sameMail(terminal.mail, mail)) throw new MailboxError("conflict", "terminal mail identity conflict");
        if (terminal.evidence.outcome === "fulfilled" && !diskTerminal)
          throw new MailboxError("unverifiable-proof", "fulfilled receipt is missing from session disk");
        return { kind: "terminal", evidence: terminal.evidence };
      }
      const old = draft.pending.find((record) => recordKey(record) === key);
      if (old) {
        if (!sameMail(old, mail)) throw new MailboxError("conflict", "pending mail identity conflict");
        return { kind: "accepted", key: mail.key, revision: old.acceptedRevision };
      }
      if (mail.anchorEntryId === null ? branch.length > 0 : !branch.some((entry) => entry.id === mail.anchorEntryId))
        throw new MailboxError("conflict", "mail origin is not current branch (null requires empty session)");
      const revision = draft.revision + 1;
      // This runs before the new snapshot is exposed. Replays of an existing
      // live key do not change its first admission, even when tagged recovered.
      if (recovered && !this.recoveryReleased) this.recoveryHeldKeys.add(key);
      else this.recoveryHeldKeys.delete(key); // discard any failed, uncommitted first admission
      draft.pending.push({
        ...mail,
        acceptedRevision: revision,
        requiredCallbacks: { recorded: !!registration.callbacks.onRecorded, terminal: !!registration.callbacks.onTerminal },
        branchEntryId: this.admissionAnchors.get(target.bindingGeneration) ?? null,
        nativeEntries: [],
        recorded: null,
      });
      return { kind: "accepted", key: mail.key, revision };
    });
    if (result.kind === "accepted" && !this.held(mail)) this.liveAccepted.set(key, mail);
    if (!this.acceptedSequence.has(key)) this.acceptedSequence.set(key, seq);
    this.hub.invalidateRecovery(this.agentDir);
    // Repeated admission is a guard recheck (child grant/recheckPrefix), not
    // permission to replay a failed source ACK with no new transport fact.
    this.schedule();
    return result;
  }
  async cancel(registration: Registration, key: string, reason: string, target: MailboxTarget): Promise<TerminalEvidence> {
    await this.ready;
    this.assertTarget(registration, target);
    if (!reason) throw new MailboxError("conflict", "cancel reason required");
    return this.terminalOperation(async () => {
      const identityKey = recordKey({ producer: registration.callbacks.id, key });
      const diskTerminal = terminalIndex(await readDiskSession(this.session), this.session.id).get(identityKey);
      let created = false;
      const evidence = await this.store.transact((draft) => {
        const old = draft.terminal.find((record) => recordKey(record.mail) === identityKey) ?? diskTerminal;
        if (old) {
          if (old.evidence.outcome === "fulfilled" && !diskTerminal)
            throw new MailboxError("unverifiable-proof", "fulfilled receipt is missing");
          return old.evidence;
        }
        const pending = draft.pending.find((record) => recordKey(record) === identityKey);
        if (!pending) throw new MailboxError("unknown-key", `unknown mailbox key: ${key}`);
        const evidence: TerminalEvidence = {
          producer: pending.producer,
          key,
          terminalId: randomUUID(),
          scope: { sessionId: this.session.id, anchorEntryId: pending.anchorEntryId },
          outcome: "cancelled",
          reason,
        };
        draft.terminal.push({
          mail: mailOnly(pending),
          branchEntryId: pending.branchEntryId,
          evidence,
          requiredCallbacks: pending.requiredCallbacks,
          recorded: pending.recorded?.ack === "pending" ? { ...pending.recorded, ack: "superseded-by-cancel" } : pending.recorded,
          terminalAck: pending.requiredCallbacks.terminal ? "pending" : "acknowledged",
          backingReceiptEntryId: null,
        });
        draft.pending = draft.pending.filter((record) => recordKey(record) !== identityKey);
        created = true;
        return evidence;
      });
      this.hub.invalidateRecovery(this.agentDir);
      if (created) this.scheduleNotices();
      return evidence;
    });
  }
  async importFulfilled(
    registration: Registration,
    mail: Mail,
    proof: LegacyFulfilledProof,
    target: MailboxTarget,
  ): Promise<TerminalEvidence> {
    mail = frozenMail(mail);
    await this.ready;
    this.assertTarget(registration, target);
    await this.rebuild();
    if (mail.producer !== registration.callbacks.id) throw new MailboxError("conflict", "import producer mismatch");
    const key = recordKey(mail);
    const existing =
      this.snapshot.terminal.find((record) => recordKey(record.mail) === key) ??
      terminalIndex(await readDiskSession(this.session), this.session.id).get(key);
    if (existing) {
      if (!sameMail(existing.mail, mail)) throw new MailboxError("conflict", "legacy terminal identity conflict");
      return existing.evidence;
    }
    const importing = this.snapshot.pending.find((record) => recordKey(record) === key && record.legacyImport);
    if (importing) {
      if (!sameMail(importing, mail) || !same(importing.legacyImport!.proof, proof))
        throw new MailboxError("conflict", "legacy import retry identity conflict");
      return this.terminalOperation(async () => {
        const evidence = await this.finishLegacyImport(importing);
        if (!evidence) throw new MailboxError("stale-binding", "legacy import execution changed before receipt");
        return evidence;
      });
    }
    // Source proof is OUTSIDE terminal serialization. A pending/cancel caller
    // must never wait on a producer callback, including an in-flight importer.
    const fence = this.fence(registration);
    const observed = await bounded(() => registration.callbacks.proveNative(mail, this.sessionManager.getBranch(), fence));
    if (!this.validFence(registration, fence) || observed.kind === "conflict")
      throw new MailboxError("unverifiable-proof", "legacy native proof unavailable");
    const native = { entries: cloneJson(observed.entries) };
    return this.terminalOperation(async () => {
      const disk = await readDiskSession(this.session);
      if (!disk) throw new MailboxError("unverifiable-proof", "legacy session has no disk history");
      const indexed = terminalIndex(disk, this.session.id).get(key),
        previous = this.snapshot.terminal.find((record) => recordKey(record.mail) === key) ?? indexed;
      if (previous) {
        if (!sameMail(previous.mail, mail)) throw new MailboxError("conflict", "legacy terminal identity conflict");
        return previous.evidence;
      }
      this.assertTarget(registration, target);
      const accepted = this.snapshot.pending.find((record) => recordKey(record) === key);
      if (accepted && !sameMail(accepted, mail)) throw new MailboxError("conflict", "legacy pending identity conflict");
      verifyLegacyRequest(mail, native.entries, proof.sourceReceiptEntryId, proof.assistantEntryId, disk);
      const evidence = {
        producer: mail.producer,
        key: mail.key,
        terminalId: randomUUID(),
        scope: { sessionId: this.session.id, anchorEntryId: mail.anchorEntryId },
        outcome: "fulfilled" as const,
        assistantEntryId: proof.assistantEntryId,
        nativeEntryIds: [...native.entries].sort((a, b) => a.messageIndex - b.messageIndex).map((entry) => entry.entryId),
      };
      await this.store.transact((draft) => {
        const pending = draft.pending.find((record) => recordKey(record) === key);
        if (pending && !sameMail(pending, mail)) throw new MailboxError("conflict", "legacy pending identity conflict");
        const requiredCallbacks = pending?.requiredCallbacks ?? {
          recorded: !!registration.callbacks.onRecorded,
          terminal: !!registration.callbacks.onTerminal,
        };
        const intent: PendingRecord = {
          ...mail,
          acceptedRevision: pending?.acceptedRevision ?? draft.revision + 1,
          requiredCallbacks,
          branchEntryId: native.entries[0]!.entryId,
          nativeEntries: native.entries,
          recorded: pending?.recorded ?? {
            notice: { producer: mail.producer, key: mail.key, scope: evidence.scope, recordedToken: randomUUID(), entries: native.entries },
            ack: requiredCallbacks.recorded ? "pending" : "acknowledged",
          },
          legacyImport: { proof, evidence },
        };
        draft.pending = draft.pending.filter((record) => recordKey(record) !== key);
        draft.pending.push(intent);
      });
      checkpoint("legacy-intent");
      const terminal = await this.finishLegacyImport(this.snapshot.pending.find((record) => recordKey(record) === key)!);
      if (!terminal) throw new MailboxError("stale-binding", "legacy import execution changed before receipt");
      return terminal;
    });
  }
  async finishLegacyImport(record: PendingRecord): Promise<TerminalEvidence | null> {
    const key = recordKey(record),
      current = this.snapshot.pending.find((item) => recordKey(item) === key);
    const old = this.snapshot.terminal.find((item) => recordKey(item.mail) === key);
    if (old) return old.evidence;
    if (!current?.legacyImport || !this.current() || !onBranch(current, current.branchEntryId, this.sessionManager.getBranch()))
      return null;
    const disk = await readDiskSession(this.session);
    if (!disk) throw new MailboxError("unverifiable-proof", "legacy import lost its disk history");
    verifyLegacyRequest(
      current,
      current.nativeEntries,
      current.legacyImport.proof.sourceReceiptEntryId,
      current.legacyImport.proof.assistantEntryId,
      disk,
    );
    const terminal = await appendDelivery(this.owner!.pi, this.owner!.ctx, this.session, {
      mail: mailOnly(current),
      branchEntryId: current.branchEntryId,
      evidence: current.legacyImport.evidence,
    });
    if (!terminal) throw new MailboxError("unverifiable-proof", "legacy delivery receipt not on disk");
    checkpoint("before-terminal");
    await this.store.transact((draft) => {
      const pending = draft.pending.find((item) => recordKey(item) === key);
      if (!pending?.legacyImport || draft.terminal.some((item) => recordKey(item.mail) === key)) return;
      draft.terminal.push({
        ...terminal,
        requiredCallbacks: pending.requiredCallbacks,
        recorded: pending.recorded,
        terminalAck: pending.requiredCallbacks.terminal ? "pending" : "acknowledged",
      });
      draft.pending = draft.pending.filter((item) => recordKey(item) !== key);
    });
    checkpoint("after-terminal");
    this.scheduleNotices();
    return terminal.evidence;
  }
  async replay(registration: Registration): Promise<void> {
    await this.ready;
    if (!this.current(registration) || this.critical) return;
    const keys = new Set([
      ...this.snapshot.pending
        .filter((record) => !record.legacyImport && record.producer === registration.callbacks.id && record.recorded?.ack === "pending")
        .map(recordKey),
      ...this.snapshot.terminal
        .filter((record) => record.mail.producer === registration.callbacks.id)
        .map((record) => recordKey(record.mail)),
    ]);
    await Promise.all(
      [...keys].map(async (key) => {
        const flightKey = JSON.stringify([key, registration.token.description, this.bindingGeneration, this.ownerEpoch]);
        const previous = this.noticeFlights.get(flightKey);
        if (previous) return previous;
        const operation = this.replayOne(registration, key).catch((error) => diagnostic(registration.binding.ctx, error));
        this.noticeFlights.set(flightKey, operation);
        try {
          await operation;
        } finally {
          if (this.noticeFlights.get(flightKey) === operation) this.noticeFlights.delete(flightKey);
        }
      }),
    );
  }
  async replayOne(registration: Registration, key: string): Promise<void> {
    const fence = this.fence(registration, null);
    const terminal = () => this.snapshot.terminal.find((record) => recordKey(record.mail) === key);
    const anyRecord = () => terminal() ?? this.snapshot.pending.find((record) => recordKey(record) === key);
    let record = anyRecord();
    if (!record || !this.validFence(registration, fence)) return;
    if (record.recorded?.ack === "pending") {
      if (!registration.callbacks.onRecorded) return; // frozen required callback, source is disabled/misconfigured
      const notice = record.recorded.notice;
      await registration.callbacks.onRecorded(notice, fence);
      checkpoint("after-recorded-source-ack");
      if (!this.validFence(registration, fence)) return;
      await this.store.transact((draft) => {
        const ti = draft.terminal.findIndex((item) => recordKey(item.mail) === key);
        const pi = draft.pending.findIndex((item) => recordKey(item) === key);
        if (ti >= 0) {
          const old = draft.terminal[ti]!;
          if (old.recorded?.notice.recordedToken === notice.recordedToken && old.recorded.ack === "pending")
            draft.terminal[ti] = { ...old, recorded: { ...old.recorded, ack: "acknowledged" } };
        } else if (pi >= 0) {
          const old = draft.pending[pi]!;
          if (old.recorded?.notice.recordedToken === notice.recordedToken && old.recorded.ack === "pending")
            draft.pending[pi] = { ...old, recorded: { ...old.recorded, ack: "acknowledged" } };
        }
      });
      checkpoint("after-recorded-ack");
      this.schedule(); // source readiness/lease/Goal claim may have changed
    }
    record = terminal();
    if (!record || !this.validFence(registration, fence)) return;
    if (record.terminalAck === "pending") {
      if (!registration.callbacks.onTerminal || record.recorded?.ack === "pending") return;
      const evidence = record.evidence;
      await registration.callbacks.onTerminal(evidence, fence);
      checkpoint("after-terminal-source-ack");
      if (!this.validFence(registration, fence)) return;
      await this.store.transact((draft) => {
        const i = draft.terminal.findIndex((item) => recordKey(item.mail) === key && item.evidence.terminalId === evidence.terminalId);
        if (i >= 0) draft.terminal[i] = { ...draft.terminal[i]!, terminalAck: "acknowledged" };
      });
      checkpoint("after-terminal-ack");
    }
    if (this.validFence(registration, fence)) await this.gc(key);
  }
  async gc(key: string): Promise<void> {
    let record = this.snapshot.terminal.find((item) => recordKey(item.mail) === key);
    if (!record || record.terminalAck !== "acknowledged" || record.recorded?.ack === "pending") return;
    let indexed = terminalIndex(await readDiskSession(this.session), this.session.id).get(key);
    if (
      !indexed &&
      record.evidence.outcome === "cancelled" &&
      this.current() &&
      onBranch(record.mail, record.branchEntryId, this.sessionManager.getBranch())
    ) {
      indexed =
        (await appendDelivery(this.owner!.pi, this.owner!.ctx, this.session, {
          mail: record.mail,
          branchEntryId: record.branchEntryId,
          evidence: record.evidence,
        })) ?? undefined;
    }
    if (!indexed || !same(indexed.evidence, record.evidence) || !sameMail(indexed.mail, record.mail)) return;
    const id = record.evidence.terminalId;
    await this.store.transact((draft) => {
      const removable = draft.terminal.some(
        (item) => item.evidence.terminalId === id && item.terminalAck === "acknowledged" && item.recorded?.ack !== "pending",
      );
      if (!removable) return;
      draft.terminal = draft.terminal.filter((item) => item.evidence.terminalId !== id);
      draft.pending = draft.pending.filter((item) => recordKey(item) !== key); // tombstone dominates any leftover physical payload
    });
    for (let i = 0; i < record.mail.messages.length; i++) this.submitted.falseBodies.delete(bodyKey(record.mail, i));
    this.liveAccepted.delete(key);
    this.hub.invalidateRecovery(this.agentDir);
  }
  async resume(): Promise<void> {
    if (!this.current()) throw new MailboxError("not-ready", "Mailbox has no delivery owner; resume cannot create one");
    const epoch = this.ownerEpoch,
      generation = this.bindingGeneration;
    await this.ready;
    if (!this.current(undefined, epoch, generation)) throw new MailboxError("stale-binding", "mailbox resume binding changed");
    this.releaseRecovery();
    if (this.snapshot.suspended)
      await this.store.transact((draft) => {
        draft.suspended = null;
      });
    this.failedIngress.clear();
    if (!this.current(undefined, epoch, generation)) return;
    // ACK repair and native delivery are scheduled independently, outside this
    // command/lifecycle stack. Retained unstarted native controls remain single-flight.
    this.scheduleNotices();
    this.schedule();
  }
}
export async function attachSlot(slot: Slot): Promise<void> {
  const descriptors = Object.getOwnPropertyDescriptors(DeliverySlot.prototype);
  Reflect.deleteProperty(descriptors, "constructor");
  Object.defineProperties(slot, descriptors);
  slot.store = slot.newStorage();
  await slot.store.acquire();
  await slot.rebuild();
  slot.scheduleNotices();
  slot.schedule();
}
export function commandFacade(hub: Hub, registrar: Registrar): MailboxCommandFacade {
  const router: MailboxCommandRouter = {
    current: (commandCtx) => {
      const id = commandCtx.sessionManager.getSessionId();
      const slot = hub.slots.get(JSON.stringify([registrar.scope.agentDir, id]));
      if (!slot || slot.sessionManager !== commandCtx.sessionManager) return null;
      return {
        slotKey: slot.key,
        status: async () => {
          await slot.ready;
          const unconfirmed =
            [...slot.submitted.falseBodies.values()].some((body) => !body.nativeEntryId) ||
            [...slot.submitted.activeControls.values(), ...slot.submitted.idleControls.values()].some((control) => !control.start);
          return {
            session: slot.session,
            hasOwner: !!slot.owner && !slot.retired,
            recoveryHeld: slot.recoveryHeld,
            suspended:
              slot.snapshot.suspended ??
              (slot.sourceErrors.size || slot.proofErrors.size
                ? { reason: "blocked", detail: [...slot.sourceErrors.values(), ...slot.proofErrors.values()].join("; ") }
                : unconfirmed
                  ? {
                      reason: "blocked",
                      detail:
                        "Native mailbox submission is unconfirmed; no live resend is allowed. Reconcile in a fresh process if its own start/proof never appears.",
                    }
                  : null),
            pending: slot.snapshot.pending
              .filter((record) => !slot.snapshot.terminal.some((item) => recordKey(item.mail) === recordKey(record)))
              .map((record) => ({ producer: record.producer, key: record.key, anchorEntryId: record.anchorEntryId })),
            sourceAckPending:
              slot.snapshot.terminal.filter((record) => record.terminalAck === "pending" || record.recorded?.ack === "pending").length +
              slot.snapshot.pending.filter((record) => record.recorded?.ack === "pending").length,
          };
        },
        resume: () => slot.resume(),
      };
    },
    completionScope: () => (hub.slots.get(registrar.scope.slotKey)?.current() ? registrar.scope : null),
    recoveryTargets: (directory) => {
      if (!hub.recovery.has(directory)) void hub.refreshRecovery(directory);
      return hub.recovery.get(directory) ?? null;
    },
    recover: (target, commandCtx) => hub.recover(target, commandCtx),
  };
  const facade = createMailboxCommandFacade(router);

  return facade;
}
export function refreshRecovery(hub: Hub, agentDir: string): Promise<void> {
  const current = hub.recoveryFlights.get(agentDir);
  if (current) return current;
  const version = hub.recoveryVersions.get(agentDir);
  const flight = import("./store.js")
    .then(({ listRecoveryTargets }) => listRecoveryTargets(agentDir))
    .then((targets) => {
      if (version !== hub.recoveryVersions.get(agentDir)) return;
      hub.recovery.set(
        agentDir,
        targets.filter((target) => {
          const slot = hub.slots.get(JSON.stringify([agentDir, target.session.id]));
          return !slot || slot.retired || !slot.owner;
        }),
      );
    })
    .catch(() => {
      hub.recovery.set(agentDir, null);
    })
    .finally(() => {
      hub.recoveryFlights.delete(agentDir);
    });
  hub.recoveryFlights.set(agentDir, flight);
  return flight;
}
export async function recover(hub: Hub, target: MailboxRecoveryTarget, ctx: ExtensionCommandContext): Promise<void> {
  const key = JSON.stringify([target.agentDir, target.session.id]),
    existing = hub.slots.get(key);
  if (
    existing?.current() ||
    (existing &&
      (existing.submitted.activeControls.size ||
        existing.submitted.idleControls.size ||
        [...existing.submitted.falseBodies.values()].some((value) => !value.nativeEntryId)))
  )
    throw new MailboxError("writer-conflict", "recovery target still has a live owner/native submission; use a fresh process");
  if (existing) {
    await existing.retire();
    hub.slots.delete(key);
  }
  if (target.session.file && existsSync(target.session.file)) {
    await ctx.switchSession(target.session.file);
    return; // reopened stays held until explicit resume/input
  }
  if (!target.session.cwd)
    throw new MailboxError("unverifiable-proof", "missing-file recovery has no original cwd; refusing to guess a project");
  const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  if (canonical(target.session.cwd) !== canonical(ctx.cwd))
    throw new MailboxError("conflict", `Recover this session from its original directory: ${target.session.cwd}`);
  const { MailboxStore } = await import("./store.js");
  const store = new MailboxStore(target.agentDir, target.session);
  await store.acquire();
  try {
    if (
      store.snapshot.pending.some((record) => record.anchorEntryId !== null || record.nativeEntries.length > 0) ||
      store.snapshot.terminal.some((record) => record.evidence.outcome === "fulfilled")
    )
      throw new MailboxError("unverifiable-proof", "missing session has nonempty history evidence; cannot fabricate it");
    const result = await ctx.newSession({
      setup: async (manager) => {
        manager.newSession({ id: target.session.id });
        const file = manager.getSessionFile();
        if (!file) throw new MailboxError("not-ready", "public newSession setup produced no persistent recovery location");
        await store.transact((draft) => {
          draft.session = { id: target.session.id, file, cwd: target.session.cwd! };
        });
        await store.close();
      },
    });
    if (result.cancelled) throw new MailboxError("not-ready", "mailbox recovery session replacement cancelled");
  } finally {
    await store.close();
  }
}
