import { createHash } from "node:crypto";
import {
  NOTIFICATION_BROKER_LIMITS_V1,
  NotificationBrokerErrorV1,
  type BrokerItemSnapshotV1,
  type LeaseWakeBindingSnapshotV1,
  type NotificationBrokerCountersV1,
  type NotificationBrokerHealthV1,
  type NotificationBrokerLimitsV1,
  type NotificationBrokerStateV1,
  type NotificationFactV1,
  type NotificationExcerptRefV1,
  type NotificationKindV1,
  type NotificationLaneV1,
  type NotificationTargetV1,
  type ObserveNotificationInputV1,
  type ObserveNotificationResultV1,
  type OverflowSourceRangeV1,
  type OverflowSummaryV1,
  type PrepareMinimalContinuationInputV1,
  type PrepareNotificationBatchInputV1,
  type PreparedNotificationBatchV1,
  type PreparedWindowSnapshotV1,
  type ProcessNotificationBatchItemV1,
  type ProcessNotificationBatchV1,
  type ProcessNotificationSnapshotV1,
  type ProcessNotificationReceiptEnvelopeV1,
  type ProcessTuiEntryEnvelopeV1,
  type RetirementPlanV1,
  type SettledBatchSnapshotV1,
  type SettledStandaloneWakeSnapshotV1,
  type StandaloneWakeBindingSnapshotV1,
  type TargetOverflowSnapshotV1,
  type TuiDeliveryIdentityV1,
  type TuiDeliveryRecordSnapshotV1,
} from "./types.js";
import { formatProcessNotificationBatchV1, NotificationFormattingErrorV1 } from "./formatting.js";

interface MutableFence {
  hostIncarnationId: string;
  highestObservedNotificationSequence: number;
  highestCommittedNotificationSequence: number;
}
interface MutableOverflowSummary {
  lane: NotificationLaneV1;
  omittedItems: number;
  byKind: Record<string, number>;
  sourceRanges: OverflowSourceRangeV1[];
  leaseWakeTransactionIds: string[];
}
interface MutableOverflow {
  target: NotificationTargetV1;
  prepared: MutableOverflowSummary[];
  open: MutableOverflowSummary[];
}
interface MutablePrepared extends PreparedWindowSnapshotV1 { itemKeys: string[] }
interface MutableCounters {
  factsObserved: number;
  repeatMatchesCoalesced: number;
  batchesPrepared: number;
  batchesCommitted: number;
  batchesRolledBack: number;
  itemsOverflowed: number;
  targetsOverflowed: number;
  tuiDeliveriesDropped: number;
}

export interface NotificationBrokerOptionsV1 {
  readonly sessionScopeId: string;
  readonly limits?: Partial<NotificationBrokerLimitsV1>;
}
export interface NotificationBrokerV1 {
  observe(input: ObserveNotificationInputV1): ObserveNotificationResultV1;
  prepare(input: PrepareNotificationBatchInputV1): PreparedNotificationBatchV1 | undefined;
  prepareMinimalContinuation(input: PrepareMinimalContinuationInputV1): PreparedNotificationBatchV1;
  discardOpenWindow(target: NotificationTargetV1, lane: NotificationLaneV1): void;
  discardOpenTurnWindow(target: NotificationTargetV1): void;
  demoteOpenTurnWindow(target: NotificationTargetV1): void;
  getPrepared(batchId: string): PreparedNotificationBatchV1 | undefined;
  commit(batchId: string): void;
  rollback(batchId: string, reason: string): void;
  discardPreparedWindow(batchId: string, reason: string): void;
  ackLeaseWakeTransaction(transactionId: string): void;
  pendingTuiDeliveries(target?: NotificationTargetV1): readonly TuiDeliveryRecordSnapshotV1[];
  ackTuiDelivery(deliveryId: string): void;
  pendingLeaseArtifacts(target?: NotificationTargetV1): readonly Readonly<{ transactionId: string; artifact: LeaseWakeBindingSnapshotV1["artifact"] }>[];
  ackLeaseArtifact(transactionId: string): void;
  bindStandaloneWake(batchId: string, input: { readonly transactionId: string; readonly claimed: boolean }): void;
  settleStandaloneWake(transactionId: string, outcome: "delivered" | "skipped"): void;
  abortStandaloneWake(transactionId: string, reason: string): void;
  clearProcess(processId: string): void;
  beginRetireTarget(retirementId: string, target: NotificationTargetV1): RetirementPlanV1;
  beginDisposeScope(retirementId: string): RetirementPlanV1;
  pendingRetirements(): readonly RetirementPlanV1[];
  ackRetirement(retirementId: string): void;
  notificationSnapshot(): ProcessNotificationSnapshotV1;
  healthSnapshot(): NotificationBrokerHealthV1;
  exportState(): NotificationBrokerStateV1;
}

const SETTLED_BATCH_LIMIT = 256;
const SETTLED_STANDALONE_WAKE_LIMIT = 256;
const ZERO_COUNTERS: MutableCounters = {
  factsObserved: 0,
  repeatMatchesCoalesced: 0,
  batchesPrepared: 0,
  batchesCommitted: 0,
  batchesRolledBack: 0,
  itemsOverflowed: 0,
  targetsOverflowed: 0,
  tuiDeliveriesDropped: 0,
};

function fail(code: ConstructorParameters<typeof NotificationBrokerErrorV1>[0], message: string): never {
  throw new NotificationBrokerErrorV1(code, message);
}
function checkedObject(value: unknown, label: string, state: boolean): Record<string, unknown> {
  const code = state ? "state-corrupt" : "invalid-fact";
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} has an invalid prototype`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(code, `${label} has a symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail(code, `${label}.${key} must be a data field`);
  }
  return value as Record<string, unknown>;
}
function plainObject(value: unknown, label: string): Record<string, unknown> { return checkedObject(value, label, true); }
function inputObject(value: unknown, label: string): Record<string, unknown> { return checkedObject(value, label, false); }
function exactFields(object: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string, state: boolean): void {
  const code = state ? "state-corrupt" : "invalid-fact";
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(object)) if (typeof key !== "string" || !allowed.has(key)) fail(code, `${label} has unknown field ${String(key)}`);
  for (const key of required) if (!Object.hasOwn(object, key)) fail(code, `${label} is missing ${key}`);
}
function exact(object: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void { exactFields(object, required, optional, label, true); }
function exactInput(object: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void { exactFields(object, required, optional, label, false); }
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail("state-corrupt", `${label} must be an array`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail("state-corrupt", `${label} must be a boolean`);
  return value;
}
function nonempty(value: unknown, label: string, maxBytes = 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) fail("invalid-fact", `${label} is invalid`);
  return value;
}
function stateString(value: unknown, label: string, maxBytes = 1024): string {
  try { return nonempty(value, label, maxBytes); } catch { fail("state-corrupt", `${label} is invalid`); }
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail("invalid-fact", `${label} is invalid`);
  return Number(value);
}
function stateInteger(value: unknown, label: string, minimum = 0): number {
  try { return integer(value, label, minimum); } catch { fail("state-corrupt", `${label} is invalid`); }
}
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string, state = false): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(state ? "state-corrupt" : "invalid-fact", `${label} is invalid`);
  return value as T;
}
function timestamp(value: unknown, label: string, state = false): string {
  const code = state ? "state-corrupt" : "invalid-fact";
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail(code, `${label} is invalid`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const offset = match[8]!;
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59 || !Number.isFinite(Date.parse(value))) fail(code, `${label} is invalid`);
  return value;
}
function inputBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail("invalid-fact", `${label} is invalid`);
  return value;
}
function targetKey(target: NotificationTargetV1): string { return JSON.stringify([target.strategy, target.scopeToken]); }
function sameTarget(first: NotificationTargetV1, second: NotificationTargetV1): boolean { return targetKey(first) === targetKey(second); }
function partitionKey(target: NotificationTargetV1, lane: NotificationLaneV1): string { return JSON.stringify([target.strategy, target.scopeToken, lane]); }
function partitionBelongsToTarget(partition: string, target: NotificationTargetV1): boolean {
  try { const [strategy, scopeToken] = JSON.parse(partition) as unknown[]; return strategy === target.strategy && scopeToken === target.scopeToken; }
  catch { return false; }
}
function laneFor(attention: ObserveNotificationInputV1["fact"]["attention"]): NotificationLaneV1 | undefined {
  return attention === "ignore" ? undefined : attention;
}
function itemId(windowId: string, key: string): string { return JSON.stringify([windowId, key]); }
function watchSnapshotKey(processId: string, key: string, generation: number): string { return JSON.stringify([processId, key, generation]); }
function cloneItem(value: BrokerItemSnapshotV1): BrokerItemSnapshotV1 { return structuredClone(value) as BrokerItemSnapshotV1; }
function cloneOverflowSummary(value: OverflowSummaryV1): MutableOverflowSummary {
  return {
    lane: value.lane,
    omittedItems: value.omittedItems,
    byKind: { ...value.byKind },
    sourceRanges: value.sourceRanges.map((range) => ({ ...range })),
    leaseWakeTransactionIds: [...value.leaseWakeTransactionIds],
  };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) if (object[key] !== undefined) result[key] = canonicalize(object[key]);
    return result;
  }
  return value;
}
export function canonicalNotificationStateJsonV1(state: NotificationBrokerStateV1): string {
  return JSON.stringify(canonicalize(state));
}

export function createProcessTuiEntryEnvelopeV1(data: Readonly<Record<string, unknown>>): ProcessTuiEntryEnvelopeV1 {
  const object = inputObject(data, "process TUI entry data");
  if (object.version !== 2) fail("invalid-fact", "process TUI entry data version is invalid");
  const dataJson = JSON.stringify(canonicalize(object));
  if (Buffer.byteLength(dataJson, "utf8") > 65_536) fail("invalid-fact", "process TUI entry data exceeds 64 KiB");
  return deepFreeze({ version: 1, customType: "process-event-v2", dataJson, dataSha256: createHash("sha256").update(dataJson).digest("hex") });
}

export function createProcessNotificationReceiptEnvelopeV1(data: Readonly<Record<string, unknown>>): ProcessNotificationReceiptEnvelopeV1 {
  const object = inputObject(data, "process notification receipt data");
  exactInput(object, ["version", "transactionId", "factId", "sessionScopeId", "target"], ["processId"], "process notification receipt data");
  if (object.version !== 1) fail("invalid-fact", "process notification receipt version is invalid");
  nonempty(object.transactionId, "receipt transaction ID", 256);
  nonempty(object.factId, "receipt fact ID", 1024);
  nonempty(object.sessionScopeId, "receipt session scope ID", 512);
  validateTarget(object.target as NotificationTargetV1);
  if (object.processId !== undefined) nonempty(object.processId, "receipt process ID", 256);
  const dataJson = JSON.stringify(canonicalize(object));
  if (Buffer.byteLength(dataJson, "utf8") > 4096) fail("invalid-fact", "process notification receipt exceeds 4 KiB");
  return deepFreeze({ version: 1, customType: "process-notification-receipt-v1", dataJson, dataSha256: createHash("sha256").update(dataJson).digest("hex") });
}

function validateLeaseArtifact(value: unknown, state: boolean, sessionScopeId: string, binding: Readonly<{ transactionId: string; factId: string; target: NotificationTargetV1; minimalItem: ProcessNotificationBatchItemV1 }>): LeaseWakeBindingSnapshotV1["artifact"] {
  const label = "lease wake artifact";
  const object = state ? plainObject(value, label) : inputObject(value, label);
  (state ? exact : exactInput)(object, ["deliveryId", "state"], ["entry"], label);
  const deliveryId = state ? stateString(object.deliveryId, `${label}.deliveryId`, 80) : nonempty(object.deliveryId, `${label}.deliveryId`, 80);
  const artifactState = enumValue(object.state, ["pending", "recorded"] as const, `${label}.state`, state);
  let entry: ProcessNotificationReceiptEnvelopeV1 | undefined;
  if (object.entry !== undefined) {
    const raw = state ? plainObject(object.entry, `${label}.entry`) : inputObject(object.entry, `${label}.entry`);
    (state ? exact : exactInput)(raw, ["version", "customType", "dataJson", "dataSha256"], [], `${label}.entry`);
    if (raw.version !== 1 || raw.customType !== "process-notification-receipt-v1") fail(state ? "state-corrupt" : "invalid-fact", `${label}.entry identity is invalid`);
    const dataJson = state ? stateString(raw.dataJson, `${label}.entry.dataJson`, 4096) : nonempty(raw.dataJson, `${label}.entry.dataJson`, 4096);
    const dataSha256 = state ? stateString(raw.dataSha256, `${label}.entry.dataSha256`, 64) : nonempty(raw.dataSha256, `${label}.entry.dataSha256`, 64);
    if (!/^[0-9a-f]{64}$/u.test(dataSha256) || createHash("sha256").update(dataJson).digest("hex") !== dataSha256) fail(state ? "state-corrupt" : "invalid-fact", `${label}.entry digest is invalid`);
    let data: unknown;
    try { data = JSON.parse(dataJson); } catch { fail(state ? "state-corrupt" : "invalid-fact", `${label}.entry data is invalid JSON`); }
    const expected = createProcessNotificationReceiptEnvelopeV1(data as Readonly<Record<string, unknown>>);
    if (expected.dataJson !== dataJson || expected.dataSha256 !== dataSha256) fail(state ? "state-corrupt" : "invalid-fact", `${label}.entry data is not canonical`);
    const receipt = data as Record<string, unknown>;
    if (receipt.transactionId !== binding.transactionId || receipt.factId !== binding.factId || receipt.sessionScopeId !== sessionScopeId || receipt.processId !== binding.minimalItem.processId || targetKey(receipt.target as NotificationTargetV1) !== targetKey(binding.target)) fail(state ? "state-corrupt" : "invalid-fact", `${label}.entry does not match its lease binding`);
    entry = expected;
  }
  if (!entry) fail(state ? "state-corrupt" : "invalid-fact", `${label} requires immutable entry evidence`);
  const expectedId = `receipt:${entry.dataSha256}`;
  if (deliveryId !== expectedId || !/^receipt:[0-9a-f]{64}$/u.test(deliveryId)) fail(state ? "state-corrupt" : "invalid-fact", `${label}.deliveryId is invalid`);
  return { deliveryId, state: artifactState, entry };
}

function validateTuiEntryEnvelope(value: unknown, state: boolean): ProcessTuiEntryEnvelopeV1 {
  const label = "process TUI entry";
  const object = state ? plainObject(value, label) : inputObject(value, label);
  (state ? exact : exactInput)(object, ["version", "customType", "dataJson", "dataSha256"], [], label);
  if (object.version !== 1 || object.customType !== "process-event-v2") fail(state ? "state-corrupt" : "invalid-fact", `${label} identity is invalid`);
  const dataJson = state ? stateString(object.dataJson, `${label}.dataJson`, 65_536) : nonempty(object.dataJson, `${label}.dataJson`, 65_536);
  const dataSha256 = state ? stateString(object.dataSha256, `${label}.dataSha256`, 64) : nonempty(object.dataSha256, `${label}.dataSha256`, 64);
  if (!/^[0-9a-f]{64}$/u.test(dataSha256) || createHash("sha256").update(dataJson).digest("hex") !== dataSha256) fail(state ? "state-corrupt" : "invalid-fact", `${label} digest is invalid`);
  let data: unknown;
  try { data = JSON.parse(dataJson); } catch { fail(state ? "state-corrupt" : "invalid-fact", `${label} data is invalid JSON`); }
  if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).version !== 2 || JSON.stringify(canonicalize(data)) !== dataJson) fail(state ? "state-corrupt" : "invalid-fact", `${label} data is not canonical process-event-v2`);
  return { version: 1, customType: "process-event-v2", dataJson, dataSha256 };
}
function withoutControlPlane(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutControlPlane);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "leaseWakeBindings" || key === "standaloneWakeBindings" || key === "settledStandaloneWakes" || key === "tuiDeliveries" || key === "pendingRetirements" || key === "leaseWakeTransactionIds") continue;
      if (child !== undefined) result[key] = withoutControlPlane(child);
    }
    return result;
  }
  return value;
}
export function measureNotificationBrokerStateV1(state: NotificationBrokerStateV1): number {
  return Buffer.byteLength(JSON.stringify(canonicalize(withoutControlPlane(state))), "utf8");
}
export function measureNotificationControlPlaneStateV1(state: NotificationBrokerStateV1): number {
  return Buffer.byteLength(JSON.stringify(canonicalize({ leaseWakeBindings: state.leaseWakeBindings, standaloneWakeBindings: state.standaloneWakeBindings, settledStandaloneWakes: state.settledStandaloneWakes, pendingRetirements: state.pendingRetirements })), "utf8");
}
export function measureNotificationTuiDeliveryStateV1(state: NotificationBrokerStateV1): number {
  return Buffer.byteLength(JSON.stringify(canonicalize(state.tuiDeliveries)), "utf8");
}

function validateTarget(target: NotificationTargetV1): void {
  const object = inputObject(target, "target");
  exactInput(object, ["strategy", "scopeToken"], [], "target");
  enumValue(object.strategy, ["main", "child"] as const, "target strategy");
  nonempty(object.scopeToken, "target scope token", 512);
}
function validateStateTarget(value: unknown, label: string): NotificationTargetV1 {
  const object = plainObject(value, label);
  exact(object, ["strategy", "scopeToken"], [], label);
  return {
    strategy: enumValue(object.strategy, ["main", "child"] as const, `${label}.strategy`, true),
    scopeToken: stateString(object.scopeToken, `${label}.scopeToken`, 512),
  };
}
function validateFact(input: ObserveNotificationInputV1, sessionScopeId: string): void {
  const envelope = inputObject(input, "notification input");
  exactInput(envelope, ["target", "fact"], ["tuiEntry", "leaseWakeTransactionId"], "notification input");
  validateTarget(input.target);
  const fact = input.fact;
  const object = inputObject(fact, "notification fact");
  exactInput(object, ["version", "factId", "sessionScopeId", "source", "observedAt", "kind", "attention"], ["process", "stableCode", "correlationId", "watch", "terminal", "excerpt"], "notification fact");
  if (fact.version !== 1) fail("invalid-fact", "fact version is invalid");
  if (fact.sessionScopeId !== sessionScopeId) fail("session-mismatch", "notification session does not match broker");
  const source = inputObject(fact.source, "notification source");
  exactInput(source, ["hostIncarnationId", "notificationSequence"], ["supervisor"], "notification source");
  const hostIncarnationId = nonempty(fact.source.hostIncarnationId, "host incarnation ID", 256);
  const notificationSequence = integer(fact.source.notificationSequence, "notification sequence", 1);
  if (fact.factId !== `${sessionScopeId}:${hostIncarnationId}:${notificationSequence}`) fail("invalid-fact", "fact ID does not match its source identity");
  if (fact.source.supervisor) {
    const supervisor = inputObject(fact.source.supervisor, "supervisor source");
    exactInput(supervisor, ["nonce", "generation", "eventSequence"], [], "supervisor source");
    nonempty(fact.source.supervisor.nonce, "supervisor nonce", 256);
    integer(fact.source.supervisor.generation, "supervisor generation", 1);
    integer(fact.source.supervisor.eventSequence, "supervisor event sequence", 1);
  }
  timestamp(fact.observedAt, "observedAt");
  enumValue(fact.attention, ["turn", "context", "ignore"] as const, "attention");
  enumValue(fact.kind, ["terminal", "watch-match", "watch-suppressed", "matcher-error", "operational"] as const, "kind");
  if (fact.process) {
    const process = inputObject(fact.process, "process identity");
    exactInput(process, ["id", "name", "kind"], [], "process identity");
    nonempty(fact.process.id, "process ID", 256); nonempty(fact.process.name, "process name", 256);
    enumValue(fact.process.kind, ["process", "monitor", "service"] as const, "process kind");
  }
  if (fact.kind === "operational") {
    nonempty(fact.stableCode, "operational stable code", 128);
    if (fact.watch || fact.terminal) fail("invalid-fact", "operational fact has inapplicable data");
  } else if (!fact.process) fail("invalid-fact", `${fact.kind} requires process identity`);
  if (fact.kind !== "operational" && fact.kind !== "matcher-error" && fact.stableCode !== undefined) fail("invalid-fact", `${fact.kind} cannot include stableCode`);
  if (fact.kind === "terminal") {
    if (!fact.terminal || fact.watch) fail("invalid-fact", "terminal fact has invalid branch data");
    validateInputTerminal(fact.terminal);
  } else if (fact.terminal) fail("invalid-fact", `${fact.kind} cannot include terminal data`);
  if (fact.kind === "watch-match" || fact.kind === "watch-suppressed" || fact.kind === "matcher-error") {
    if (!fact.watch) fail("invalid-fact", `${fact.kind} requires watch data`);
    validateInputWatch(fact.watch);
    if (fact.kind === "matcher-error") nonempty(fact.stableCode, "matcher stable code", 128);
  } else if (fact.watch) fail("invalid-fact", `${fact.kind} cannot include watch data`);
  if (fact.excerpt) {
    const excerpt = inputObject(fact.excerpt, "excerpt reference");
    exactInput(excerpt, ["processId", "stream", "firstSequence", "lastSequence", "truncated"], [], "excerpt reference");
    if (!fact.process || fact.excerpt.processId !== fact.process.id) fail("invalid-fact", "excerpt process identity is invalid");
    nonempty(fact.excerpt.processId, "excerpt process ID", 256); enumValue(fact.excerpt.stream, ["stdout", "stderr"] as const, "excerpt stream");
    const first = integer(fact.excerpt.firstSequence, "excerpt first sequence", 1);
    integer(fact.excerpt.lastSequence, "excerpt last sequence", first); inputBoolean(fact.excerpt.truncated, "excerpt truncated");
  }
  nonempty(fact.factId, "fact ID", 1024);
  nonempty(fact.sessionScopeId, "session scope ID", 512);
  if (fact.stableCode !== undefined) nonempty(fact.stableCode, "stable code", 128);
  if (fact.correlationId !== undefined) nonempty(fact.correlationId, "correlation ID", 256);
  if (input.tuiEntry !== undefined) {
    const entry = validateTuiEntryEnvelope(input.tuiEntry, false);
    const data = JSON.parse(entry.dataJson) as Record<string, unknown>;
    const expectedKind = fact.kind === "matcher-error" ? "matcher-error" : fact.kind;
    if (data.kind !== expectedKind) fail("invalid-fact", "process TUI entry kind does not match the notification fact");
    if (!data.process || typeof data.process !== "object" || Array.isArray(data.process)
      || (data.process as Record<string, unknown>).id !== fact.process?.id) {
      fail("invalid-fact", "process TUI entry process does not match the notification fact");
    }
    const expectedEventSequence = fact.source.supervisor?.eventSequence ?? fact.source.notificationSequence;
    if (data.eventSequence !== expectedEventSequence) fail("invalid-fact", "process TUI entry eventSequence does not match the notification fact");
  }
  if (input.leaseWakeTransactionId !== undefined) nonempty(input.leaseWakeTransactionId, "lease transaction ID", 256);
}
function validateInputWatch(watchValue: NonNullable<NotificationFactV1["watch"]>): void {
  const watch = inputObject(watchValue, "watch data");
  exactInput(watch, ["key", "generation", "repeat", "firstSequence", "lastSequence", "count"], [], "watch data");
  nonempty(watchValue.key, "watch key", 128); integer(watchValue.generation, "watch generation", 1); inputBoolean(watchValue.repeat, "watch repeat");
  const first = integer(watchValue.firstSequence, "watch first sequence", 1); integer(watchValue.lastSequence, "watch last sequence", first);
  integer(watchValue.count, "watch count", 1);
}
function validateInputTerminal(terminalValue: NonNullable<NotificationFactV1["terminal"]>): void {
  const terminal = inputObject(terminalValue, "terminal data");
  exactInput(terminal, ["outcome", "cause", "durationMs"], ["exitCode", "signal", "timeoutMs"], "terminal data");
  enumValue(terminalValue.outcome, ["succeeded", "failed", "stopped", "killed", "crashed"] as const, "terminal outcome");
  enumValue(terminalValue.cause, ["completed", "exit-code", "signal", "runtime-error", "stopped", "killed", "timeout"] as const, "terminal cause");
  integer(terminalValue.durationMs, "terminal duration");
  if (terminalValue.exitCode !== undefined) integer(terminalValue.exitCode, "terminal exit code");
  if (terminalValue.signal !== undefined) nonempty(terminalValue.signal, "terminal signal", 64);
  if (terminalValue.timeoutMs !== undefined) integer(terminalValue.timeoutMs, "terminal timeout", 1);
  const expectedOutcome = terminalValue.cause === "completed" ? "succeeded"
    : terminalValue.cause === "stopped" ? "stopped"
      : terminalValue.cause === "killed" ? "killed"
        : terminalValue.cause === "runtime-error" ? "crashed" : "failed";
  if (terminalValue.outcome !== expectedOutcome) fail("invalid-fact", "terminal outcome and cause are inconsistent");
  if (terminalValue.cause === "exit-code" && (terminalValue.exitCode === undefined || terminalValue.exitCode === 0)) fail("invalid-fact", "exit-code terminal requires a non-zero exitCode");
  if (terminalValue.cause === "completed" && terminalValue.exitCode !== undefined && terminalValue.exitCode !== 0) fail("invalid-fact", "completed terminal exitCode must be zero");
  if ((terminalValue.cause === "signal" || terminalValue.cause === "killed") && terminalValue.signal === undefined) fail("invalid-fact", `${terminalValue.cause} terminal requires signal`);
  if (terminalValue.cause === "timeout" && terminalValue.timeoutMs === undefined) fail("invalid-fact", "timeout terminal requires timeoutMs");
}
function validateMinimalContinuationItem(itemValue: ProcessNotificationBatchItemV1, binding: LeaseWakeBindingSnapshotV1): void {
  const item = inputObject(itemValue, "minimal continuation item");
  exactInput(item, ["kind", "count", "firstFactId", "lastFactId", "hostIncarnationId", "firstNotificationSequence", "lastNotificationSequence", "firstObservedAt", "lastObservedAt"], ["processId", "processName", "stableCode", "watchKey", "watchGeneration", "matchedCount", "suppressedCount", "terminal"], "minimal continuation item");
  enumValue(itemValue.kind, ["terminal", "watch-match", "matcher-error"] as const, "minimal continuation kind");
  if (itemValue.count !== 1) fail("invalid-fact", "minimal continuation count must be one");
  if (itemValue.matchedCount !== undefined && itemValue.matchedCount !== 1) fail("invalid-fact", "minimal continuation matched count is invalid");
  if (itemValue.suppressedCount !== undefined && itemValue.suppressedCount !== 0) fail("invalid-fact", "minimal continuation suppressed count is invalid");
  if (itemValue.firstFactId !== binding.factId || itemValue.lastFactId !== binding.factId) fail("invalid-fact", "minimal continuation fact identity is invalid");
  if (itemValue.hostIncarnationId !== binding.hostIncarnationId || itemValue.firstNotificationSequence !== binding.notificationSequence || itemValue.lastNotificationSequence !== binding.notificationSequence) fail("invalid-fact", "minimal continuation source identity is invalid");
  timestamp(itemValue.firstObservedAt, "minimal continuation firstObservedAt"); timestamp(itemValue.lastObservedAt, "minimal continuation lastObservedAt");
  if (Date.parse(itemValue.firstObservedAt) > Date.parse(itemValue.lastObservedAt)) fail("invalid-fact", "minimal continuation observed range is invalid");
  if (!itemValue.processId || !itemValue.processName) fail("invalid-fact", "minimal continuation requires process identity");
  nonempty(itemValue.processId, "minimal continuation process ID", 256); nonempty(itemValue.processName, "minimal continuation process name", 256);
  if (itemValue.kind === "watch-match" || itemValue.kind === "matcher-error") {
    nonempty(itemValue.watchKey, "minimal continuation watch key", 128); integer(itemValue.watchGeneration, "minimal continuation watch generation", 1);
  } else if (itemValue.watchKey !== undefined || itemValue.watchGeneration !== undefined) fail("invalid-fact", "minimal terminal continuation cannot include watch identity");
  if (itemValue.kind === "watch-match" && (itemValue.matchedCount !== 1 || itemValue.suppressedCount !== 0)) fail("invalid-fact", "minimal watch continuation requires exact match counts");
  if (itemValue.kind === "matcher-error" && !itemValue.stableCode) fail("invalid-fact", "minimal matcher continuation requires stableCode");
  if (itemValue.kind !== "matcher-error" && itemValue.stableCode !== undefined) fail("invalid-fact", "minimal continuation stableCode is not applicable");
  if (itemValue.kind === "terminal") {
    if (!itemValue.terminal) fail("invalid-fact", "minimal terminal continuation requires terminal data");
    validateInputTerminal(itemValue.terminal);
  } else if (itemValue.terminal) fail("invalid-fact", "non-terminal minimal continuation cannot include terminal data");
}
function snapshotAggregateKey(
  target: NotificationTargetV1,
  lane: NotificationLaneV1,
  hostIncarnationId: string,
  identity: BrokerItemSnapshotV1["identity"],
  uniqueFactId: string,
): string {
  const processId = identity.process?.id ?? null;
  let discriminator: unknown[];
  if (identity.kind === "watch-match" && identity.watch?.repeat) {
    discriminator = ["watch", processId, identity.watch.key, identity.watch.generation, identity.attention];
  } else if (identity.kind === "watch-match") discriminator = ["watch-unique", uniqueFactId];
  else if (identity.kind === "terminal") discriminator = ["terminal", processId];
  else if (identity.kind === "matcher-error") discriminator = ["matcher", processId, identity.watch?.key, identity.watch?.generation, identity.stableCode];
  else discriminator = ["operational", identity.stableCode, identity.correlationId ?? null];
  return JSON.stringify([target.strategy, target.scopeToken, lane, hostIncarnationId, ...discriminator]);
}
function aggregateKey(input: ObserveNotificationInputV1, lane: NotificationLaneV1): string {
  const { fact, target } = input;
  return snapshotAggregateKey(target, lane, fact.source.hostIncarnationId, {
    kind: fact.kind === "watch-suppressed" ? "watch-match" : fact.kind,
    attention: fact.attention,
    ...(fact.process ? { process: fact.process } : {}),
    ...(fact.stableCode ? { stableCode: fact.stableCode } : {}),
    ...(fact.correlationId ? { correlationId: fact.correlationId } : {}),
    ...(fact.watch ? { watch: watchIdentity(fact.watch) } : {}),
    ...(fact.terminal ? { terminal: fact.terminal } : {}),
  }, fact.factId);
}
function tuiIdentity(input: ObserveNotificationInputV1): TuiDeliveryIdentityV1 | undefined {
  const { fact } = input;
  if (fact.kind === "watch-suppressed" || (fact.kind === "terminal" && fact.terminal?.cause === "stopped")) return undefined;
  if (fact.kind === "terminal" || (fact.kind === "watch-match" && !fact.watch?.repeat)) {
    return { kind: "unique", eventKind: fact.kind, hostIncarnationId: fact.source.hostIncarnationId, processId: fact.process!.id, factId: fact.factId };
  }
  if (fact.kind === "watch-match") {
    return { kind: "watch", hostIncarnationId: fact.source.hostIncarnationId, processId: fact.process!.id, watchKey: fact.watch!.key, watchGeneration: fact.watch!.generation };
  }
  if (fact.kind === "matcher-error") {
    return { kind: "matcher", hostIncarnationId: fact.source.hostIncarnationId, processId: fact.process!.id, watchKey: fact.watch!.key, watchGeneration: fact.watch!.generation, stableCode: fact.stableCode! };
  }
  return { kind: "operational", hostIncarnationId: fact.source.hostIncarnationId, ...(fact.process ? { processId: fact.process.id } : {}), stableCode: fact.stableCode!, ...(fact.correlationId ? { correlationId: fact.correlationId } : {}) };
}
function tuiDeliveryId(target: NotificationTargetV1, identity: TuiDeliveryIdentityV1): string {
  const canonical = JSON.stringify(canonicalize({ target, identity }));
  return `tui:${createHash("sha256").update(canonical).digest("hex")}`;
}
function itemOrder(a: BrokerItemSnapshotV1, b: BrokerItemSnapshotV1): number {
  if (a.hostIncarnationId === b.hostIncarnationId) return a.firstNotificationSequence - b.firstNotificationSequence || a.key.localeCompare(b.key);
  return Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt)
    || a.firstObservedAt.localeCompare(b.firstObservedAt)
    || a.hostIncarnationId.localeCompare(b.hostIncarnationId)
    || a.firstNotificationSequence - b.firstNotificationSequence
    || a.key.localeCompare(b.key);
}
function watchIdentity(watch: NonNullable<ObserveNotificationInputV1["fact"]["watch"]>): Omit<NonNullable<ObserveNotificationInputV1["fact"]["watch"]>, "count"> {
  const { count: _count, ...identity } = watch;
  return identity;
}
function factToMinimalItem(fact: NotificationFactV1): ProcessNotificationBatchItemV1 {
  if (!fact.process || (fact.kind !== "terminal" && fact.kind !== "watch-match" && fact.kind !== "matcher-error")) {
    fail("invalid-fact", "lease fact cannot form a minimal continuation");
  }
  return {
    kind: fact.kind,
    processId: fact.process.id,
    processName: fact.process.name,
    ...(fact.stableCode ? { stableCode: fact.stableCode } : {}),
    ...(fact.watch ? { watchKey: fact.watch.key, watchGeneration: fact.watch.generation } : {}),
    count: 1,
    ...(fact.kind === "watch-match" ? { matchedCount: 1, suppressedCount: 0 } : {}),
    firstFactId: fact.factId,
    lastFactId: fact.factId,
    hostIncarnationId: fact.source.hostIncarnationId,
    firstNotificationSequence: fact.source.notificationSequence,
    lastNotificationSequence: fact.source.notificationSequence,
    firstObservedAt: fact.observedAt,
    lastObservedAt: fact.observedAt,
    ...(fact.terminal ? { terminal: structuredClone(fact.terminal) } : {}),
  };
}

function toBatchItem(item: BrokerItemSnapshotV1): ProcessNotificationBatchItemV1 {
  return {
    kind: item.identity.kind,
    ...(item.identity.process ? { processId: item.identity.process.id, processName: item.identity.process.name } : {}),
    ...(item.identity.stableCode ? { stableCode: item.identity.stableCode } : {}),
    ...(item.identity.watch ? { watchKey: item.identity.watch.key, watchGeneration: item.identity.watch.generation } : {}),
    count: item.count,
    ...(item.matchedCount === undefined ? {} : { matchedCount: item.matchedCount }),
    ...(item.suppressedCount === undefined ? {} : { suppressedCount: item.suppressedCount }),
    firstFactId: item.firstFactId,
    lastFactId: item.lastFactId,
    hostIncarnationId: item.hostIncarnationId,
    firstNotificationSequence: item.firstNotificationSequence,
    lastNotificationSequence: item.lastNotificationSequence,
    firstObservedAt: item.firstObservedAt,
    lastObservedAt: item.lastObservedAt,
    ...(item.identity.terminal ? { terminal: item.identity.terminal } : {}),
    ...(item.latestExcerptRef ? { excerptRef: item.latestExcerptRef } : {}),
  };
}

function overflowCounts(items: readonly BrokerItemSnapshotV1[], existing?: OverflowSummaryV1): { omittedItems: number; byKind: Record<string, number> } | undefined {
  const byKind: Record<string, number> = { ...(existing?.byKind ?? {}) };
  let omittedItems = existing?.omittedItems ?? 0;
  for (const item of items) {
    omittedItems += item.count;
    byKind[item.identity.kind] = (byKind[item.identity.kind] ?? 0) + item.count;
  }
  return omittedItems > 0 ? { omittedItems, byKind } : undefined;
}

function canonicalBatchJson(batch: ProcessNotificationBatchV1): string { return JSON.stringify(canonicalize(batch)); }
function itemsForPreparedWindow(items: readonly BrokerItemSnapshotV1[], prepared: PreparedWindowSnapshotV1): BrokerItemSnapshotV1[] {
  return items.filter((item) => item.windowId === prepared.windowId);
}

function buildAggregateBatch(
  input: PrepareNotificationBatchInputV1,
  sessionScopeId: string,
  mode: ProcessNotificationBatchV1["mode"],
  sorted: readonly BrokerItemSnapshotV1[],
  existingOverflow: OverflowSummaryV1 | undefined,
  limits: NotificationBrokerLimitsV1,
): ProcessNotificationBatchV1 {
  const maximum = Math.min(sorted.length, limits.batchItems);
  let selected = 0;
  let result: ProcessNotificationBatchV1 | undefined;
  for (let count = 0; count <= maximum; count++) {
    const overflow = overflowCounts(sorted.slice(count), existingOverflow);
    const candidate: ProcessNotificationBatchV1 = {
      version: 1,
      batchId: input.batchId,
      sessionScopeId,
      epochId: input.epochId,
      reason: input.reason,
      mode,
      createdAt: input.createdAt,
      items: sorted.slice(0, count).map(toBatchItem),
      ...(overflow ? { overflow } : {}),
    };
    try {
      formatProcessNotificationBatchV1(candidate, { maxBytes: limits.batchBytes, maxExcerptBytes: 0 });
      selected = count;
      result = candidate;
    } catch (error) {
      if (!(error instanceof NotificationFormattingErrorV1)) throw error;
      break;
    }
  }
  if (!result || (sorted.length > 0 && selected === 0)) fail("capacity", "notification batch mandatory content exceeds byte budget");
  return deepFreeze(result);
}

class NotificationBroker implements NotificationBrokerV1 {
  readonly sessionScopeId: string;
  readonly limits: NotificationBrokerLimitsV1;
  revision = 0;
  degraded = false;
  fences = new Map<string, MutableFence>();
  items = new Map<string, BrokerItemSnapshotV1>();
  prepared = new Map<string, MutablePrepared>();
  openWindows = new Map<string, string>();
  overflows = new Map<string, MutableOverflow>();
  processOwners = new Map<string, NotificationTargetV1>();
  watches = new Map<string, ProcessNotificationSnapshotV1["watches"][number]>();
  terminalProcesses = new Map<string, string>();
  leaseWakeBindings = new Map<string, LeaseWakeBindingSnapshotV1>();
  standaloneWakeBindings = new Map<string, StandaloneWakeBindingSnapshotV1>();
  settledStandaloneWakes = new Map<string, SettledStandaloneWakeSnapshotV1["outcome"]>();
  tuiDeliveries = new Map<string, TuiDeliveryRecordSnapshotV1>();
  retirementPlans = new Map<string, RetirementPlanV1>();
  settledBatches = new Map<string, SettledBatchSnapshotV1["outcome"]>();
  disposed = false;
  counters: MutableCounters = { ...ZERO_COUNTERS };
  nextWindow = 1;

  constructor(options: NotificationBrokerOptionsV1) {
    this.sessionScopeId = nonempty(options.sessionScopeId, "session scope ID", 512);
    this.limits = Object.freeze({ ...NOTIFICATION_BROKER_LIMITS_V1, ...options.limits });
    if (this.limits.generalSlots + this.limits.terminalSlots + this.limits.targetOverflowSlots !== this.limits.totalSlots) {
      fail("state-corrupt", "notification slot limits are inconsistent");
    }
  }

  private requireActive(): void {
    if (this.disposed) fail("invalid-fact", "notification broker is disposed");
    if ([...this.retirementPlans.values()].some((entry) => entry.kind === "scope")) fail("invalid-fact", "notification scope is retiring");
  }
  private requireTargetActive(target: NotificationTargetV1): void {
    if ([...this.retirementPlans.values()].some((entry) => entry.target && sameTarget(entry.target, target))) fail("invalid-fact", "notification target is retiring");
  }
  private requireTransactionMutable(transactionId: string, kind: "lease" | "standalone"): void {
    const binding = kind === "lease" ? this.leaseWakeBindings.get(transactionId) : this.standaloneWakeBindings.get(transactionId);
    if (!binding) return;
    if ([...this.retirementPlans.values()].some((plan) => plan.kind === "scope" || (plan.target && sameTarget(plan.target, binding.target)))) {
      fail("invalid-fact", `${kind} transaction belongs to a retiring owner`);
    }
  }
  private requireProcessMutable(processId: string): void {
    const owner = this.processOwners.get(processId);
    for (const plan of this.retirementPlans.values()) {
      if (plan.kind === "scope" || (owner && plan.target && sameTarget(owner, plan.target))) {
        fail("invalid-fact", "process belongs to a retiring owner");
      }
    }
  }

  private atomic<T>(operation: () => T): T {
    this.requireActive();
    return this.atomicRetirement(operation);
  }
  private atomicRetirement<T>(operation: () => T): T {
    if (this.disposed) fail("invalid-fact", "notification broker is disposed");
    const before = this.exportState();
    try { return operation(); }
    catch (error) { this.loadState(before); throw error; }
  }

  observe(input: ObserveNotificationInputV1): ObserveNotificationResultV1 {
    this.requireActive();
    validateFact(input, this.sessionScopeId);
    this.requireTargetActive(input.target);
    const before = this.exportState();
    try {
      const fact = input.fact;
      const existingFence = this.fences.get(fact.source.hostIncarnationId);
      const expected = (existingFence?.highestObservedNotificationSequence ?? 0) + 1;
      if (fact.source.notificationSequence < expected) fail("sequence-replay", "notification sequence was already observed");
      if (fact.source.notificationSequence > expected) { this.degraded = true; fail("sequence-gap", "notification sequence contains a gap"); }
      if (fact.process) {
        const owner = this.processOwners.get(fact.process.id);
        if (owner && !sameTarget(owner, input.target)) fail("invalid-fact", `process ${fact.process.id} belongs to another notification target`);
      }
      if (fact.kind === "terminal") {
        const prior = this.terminalProcesses.get(fact.process!.id);
        if (prior) fail("terminal-conflict", `process ${fact.process!.id} already has terminal fact ${prior}`);
      }
      if (input.leaseWakeTransactionId) {
        const existing = this.leaseWakeBindings.get(input.leaseWakeTransactionId);
        if (existing) fail("invalid-fact", `lease transaction ${existing.transactionId} is already bound`);
      }

      this.fences.set(fact.source.hostIncarnationId, existingFence ?? {
        hostIncarnationId: fact.source.hostIncarnationId,
        highestObservedNotificationSequence: 0,
        highestCommittedNotificationSequence: 0,
      });
      this.fences.get(fact.source.hostIncarnationId)!.highestObservedNotificationSequence = fact.source.notificationSequence;
      if (fact.process && !this.processOwners.has(fact.process.id)) this.processOwners.set(fact.process.id, structuredClone(input.target));
      this.counters.factsObserved++;
      this.revision++;
      this.observeWatch(fact);
      if (fact.kind === "terminal") this.terminalProcesses.set(fact.process!.id, fact.factId);
      const tui = this.observeTuiDelivery(input);
      const lane = laneFor(fact.attention);
      if (input.leaseWakeTransactionId) {
        const receiptEntry = createProcessNotificationReceiptEnvelopeV1({
          version: 1,
          transactionId: input.leaseWakeTransactionId,
          factId: fact.factId,
          sessionScopeId: fact.sessionScopeId,
          target: input.target,
          ...(fact.process ? { processId: fact.process.id } : {}),
        });
        this.leaseWakeBindings.set(input.leaseWakeTransactionId, {
          transactionId: input.leaseWakeTransactionId,
          factId: fact.factId,
          target: structuredClone(input.target),
          lane: lane ?? "ignore",
          hostIncarnationId: fact.source.hostIncarnationId,
          notificationSequence: fact.source.notificationSequence,
          artifact: {
            deliveryId: `receipt:${receiptEntry.dataSha256}`,
            state: "pending",
            entry: receiptEntry,
          },
          minimalItem: deepFreeze(factToMinimalItem(fact)),
        });
      }

      if (!lane) {
        this.recomputeCommittedFences();
        this.assertCapacity();
        return deepFreeze({ factId: fact.factId, notificationSequence: fact.source.notificationSequence, revision: this.revision, modelDisposition: "ignored", tuiDisposition: tui.disposition, ...(tui.deliveryId ? { tuiDeliveryId: tui.deliveryId } : {}) });
      }
      if (!this.hasModelPartition(input.target)) {
        this.counters.targetsOverflowed++;
        this.recomputeCommittedFences();
        this.assertCapacity();
        return deepFreeze({ factId: fact.factId, notificationSequence: fact.source.notificationSequence, revision: this.revision, modelDisposition: "target-overflowed", tuiDisposition: tui.disposition, ...(tui.deliveryId ? { tuiDeliveryId: tui.deliveryId } : {}) });
      }

      const pkey = partitionKey(input.target, lane);
      let windowId = this.openWindows.get(pkey);
      if (!windowId) { windowId = `window-${this.nextWindow++}`; this.openWindows.set(pkey, windowId); }
      const key = aggregateKey(input, lane);
      const id = itemId(windowId, key);
      const existing = this.items.get(id);
      const repeated = existing !== undefined;
      if (existing) this.items.set(id, this.mergeItem(existing, input));
      else this.items.set(id, this.newItem(key, windowId, lane, input));
      if (repeated) this.counters.repeatMatchesCoalesced++;
      this.applyPressure();
      this.recomputeCommittedFences();
      this.assertCapacity();
      return deepFreeze({ factId: fact.factId, notificationSequence: fact.source.notificationSequence, revision: this.revision, modelDisposition: this.items.has(id) ? "aggregated" : "target-overflowed", tuiDisposition: tui.disposition, ...(tui.deliveryId ? { tuiDeliveryId: tui.deliveryId } : {}) });
    } catch (error) {
      const preserveDegraded = error instanceof NotificationBrokerErrorV1 && error.code === "sequence-gap";
      this.loadState(before);
      if (preserveDegraded) this.degraded = true;
      throw error;
    }
  }

  prepare(input: PrepareNotificationBatchInputV1): PreparedNotificationBatchV1 | undefined {
    return this.atomic(() => this.prepareAggregate(input));
  }

  private prepareAggregate(input: PrepareNotificationBatchInputV1): PreparedNotificationBatchV1 | undefined {
    const object = inputObject(input, "prepare input"); exactInput(object, ["target", "lane", "batchId", "epochId", "reason", "createdAt"], ["mode"], "prepare input");
    validateTarget(input.target); this.requireTargetActive(input.target); enumValue(input.lane, ["context", "turn"] as const, "prepare lane"); nonempty(input.batchId, "batch ID", 256); nonempty(input.epochId, "epoch ID", 256);
    enumValue(input.reason, ["user-boundary", "main-admission", "subagent-admission"] as const, "prepare reason"); timestamp(input.createdAt, "prepare createdAt");
    if (input.mode !== undefined) enumValue(input.mode, ["aggregate", "minimal-continuation"] as const, "prepare mode");
    if (this.settledBatches.has(input.batchId) || this.prepared.has(input.batchId)) fail("batch-id-conflict", "batch ID already exists");
    const pkey = partitionKey(input.target, input.lane);
    if ([...this.prepared.values()].some((entry) => partitionKey(entry.target, entry.lane) === pkey)) fail("prepare-in-progress", "target lane already has a prepared batch");
    const windowId = this.openWindows.get(pkey);
    const overflow = this.overflows.get(targetKey(input.target));
    const openOverflow = overflow?.open.find((summary) => summary.lane === input.lane);
    if (!windowId && !openOverflow) return undefined;
    const ids = windowId ? [...this.items.entries()].filter(([, item]) => item.windowId === windowId).map(([id]) => id) : [];
    if (ids.length === 0 && !openOverflow) return undefined;
    const mode = input.mode ?? "aggregate";
    if (mode === "minimal-continuation") fail("invalid-fact", "minimal continuation must use prepareMinimalContinuation");
    const sorted = ids.map((id) => this.items.get(id)!).sort(itemOrder);
    const batch = buildAggregateBatch(input, this.sessionScopeId, mode, sorted, openOverflow, this.limits);
    const leaseWakeTransactionIds = this.leaseIdsForPrepared(
      { target: input.target } as MutablePrepared,
      sorted,
      openOverflow,
    );
    const prepared: MutablePrepared = {
      batchId: input.batchId, target: structuredClone(input.target), lane: input.lane,
      windowId: windowId ?? `overflow-${this.nextWindow++}`, epochId: input.epochId, reason: input.reason,
      mode, createdAt: input.createdAt, itemKeys: ids, leaseWakeTransactionIds, batch, settled: false,
    };
    const unboundStandalone = input.lane === "turn"
      ? [...this.standaloneWakeBindings.values()].filter((binding) => !binding.batchId && sameTarget(binding.target, input.target))
      : [];
    if (unboundStandalone.length > 1) fail("invalid-fact", "multiple standalone transactions require explicit resolution");
    this.prepared.set(input.batchId, prepared);
    if (unboundStandalone[0]) this.standaloneWakeBindings.set(unboundStandalone[0].transactionId, { ...unboundStandalone[0], phase: "batch-prepared", batchId: input.batchId });
    if (windowId) this.openWindows.delete(pkey);
    if (overflow && openOverflow) {
      overflow.open = overflow.open.filter((summary) => summary.lane !== input.lane);
      overflow.prepared.push(openOverflow);
    }
    this.counters.batchesPrepared++; this.revision++;
    this.assertCapacity();
    return deepFreeze({ batch, leaseWakeTransactionIds });
  }

  demoteOpenTurnWindow(target: NotificationTargetV1): void {
    this.atomic(() => {
      validateTarget(target);
      this.requireTargetActive(target);
      const turnPartition = partitionKey(target, "turn");
      const contextPartition = partitionKey(target, "context");
      if ([...this.prepared.values()].some((entry) => partitionKey(entry.target, entry.lane) === turnPartition)) fail("prepare-in-progress", "prepared turn window cannot be demoted");
      if ([...this.standaloneWakeBindings.values()].some((binding) => sameTarget(binding.target, target))) fail("prepare-in-progress", "standalone turn transaction prevents window demotion");
      const turnWindow = this.openWindows.get(turnPartition);
      const overflow = this.overflows.get(targetKey(target));
      const turnOverflow = overflow?.open.find((summary) => summary.lane === "turn");
      if (!turnWindow && !turnOverflow) return;
      let contextWindow = this.openWindows.get(contextPartition);
      if (!contextWindow) { contextWindow = `window-${this.nextWindow++}`; this.openWindows.set(contextPartition, contextWindow); }
      if (turnWindow) {
        for (const [oldId, item] of [...this.items]) {
          if (item.windowId !== turnWindow) continue;
          this.items.delete(oldId);
          const identity = { ...structuredClone(item.identity), attention: "context" as const };
          const moved: BrokerItemSnapshotV1 = { ...cloneItem(item), key: snapshotAggregateKey(item.target, "context", item.hostIncarnationId, identity, item.firstFactId), windowId: contextWindow, lane: "context", identity };
          const nextId = itemId(contextWindow, moved.key);
          const existing = this.items.get(nextId);
          this.items.set(nextId, existing ? this.mergeSnapshots(existing, moved) : moved);
        }
        this.openWindows.delete(turnPartition);
      }
      if (overflow && turnOverflow) {
        overflow.open = overflow.open.filter((summary) => summary !== turnOverflow);
        const contextOverflow = overflow.open.find((summary) => summary.lane === "context");
        overflow.open = overflow.open.filter((summary) => summary !== contextOverflow);
        overflow.open.push(this.mergeOverflow({ ...turnOverflow, lane: "context" }, contextOverflow));
      }
      this.revision++; this.applyPressure(); this.recomputeCommittedFences(); this.assertCapacity();
    });
  }

  discardOpenWindow(target: NotificationTargetV1, lane: NotificationLaneV1): void {
    this.atomic(() => {
      validateTarget(target);
      enumValue(lane, ["context", "turn"] as const, "notification lane");
      this.requireTargetActive(target);
      const partition = partitionKey(target, lane);
      if ([...this.prepared.values()].some((entry) => partitionKey(entry.target, entry.lane) === partition)) {
        fail("prepare-in-progress", `prepared ${lane} window cannot be discarded`);
      }
      if (lane === "turn" && [...this.standaloneWakeBindings.values()].some((binding) => sameTarget(binding.target, target))) {
        fail("prepare-in-progress", "standalone turn transaction prevents window discard");
      }
      const windowId = this.openWindows.get(partition);
      if (windowId) {
        for (const [id, item] of [...this.items]) if (item.windowId === windowId) this.items.delete(id);
        this.openWindows.delete(partition);
      }
      const overflow = this.overflows.get(targetKey(target));
      if (overflow) {
        overflow.open = overflow.open.filter((summary) => summary.lane !== lane);
        if (overflow.open.length === 0 && overflow.prepared.length === 0) this.overflows.delete(targetKey(target));
      }
      this.revision++;
      this.recomputeCommittedFences();
      this.assertCapacity();
    });
  }

  discardOpenTurnWindow(target: NotificationTargetV1): void {
    this.discardOpenWindow(target, "turn");
  }

  prepareMinimalContinuation(input: PrepareMinimalContinuationInputV1): PreparedNotificationBatchV1 {
    return this.atomic(() => {
      const object = inputObject(input, "minimal continuation input"); exactInput(object, ["target", "batchId", "epochId", "reason", "createdAt", "leaseWakeTransactionIds"], [], "minimal continuation input");
      validateTarget(input.target); this.requireTargetActive(input.target); nonempty(input.batchId, "batch ID", 256); nonempty(input.epochId, "epoch ID", 256); enumValue(input.reason, ["main-admission", "subagent-admission"] as const, "minimal continuation reason");
      const rawIds = array(input.leaseWakeTransactionIds, "minimal continuation lease transactions");
      if (rawIds.length < 1 || rawIds.length > 50) fail("invalid-fact", "minimal continuation requires between one and fifty lease transactions");
      const ids = rawIds.map((value) => nonempty(value, "lease transaction ID", 256));
      if (new Set(ids).size !== ids.length) fail("invalid-fact", "minimal continuation lease transactions must be unique");
      if (this.settledBatches.has(input.batchId) || this.prepared.has(input.batchId)) fail("batch-id-conflict", "batch ID already exists");
      const bindings = ids.map((id) => this.leaseWakeBindings.get(id));
      if (bindings.some((binding) => !binding || targetKey(binding.target) !== targetKey(input.target))) fail("invalid-fact", "minimal continuation lease binding is invalid");
      const frozen = (bindings as LeaseWakeBindingSnapshotV1[]).sort((a, b) => a.hostIncarnationId.localeCompare(b.hostIncarnationId) || a.notificationSequence - b.notificationSequence || a.transactionId.localeCompare(b.transactionId));
      for (const binding of frozen) validateMinimalContinuationItem(binding.minimalItem, binding);
      const transactionIds = frozen.map((binding) => binding.transactionId);
      const lane: NotificationLaneV1 = "turn";
      const pkey = partitionKey(input.target, lane);
      if ([...this.prepared.values()].some((entry) => partitionKey(entry.target, entry.lane) === pkey)) {
        fail("prepare-in-progress", "target lane already has a prepared batch");
      }
      const batch: ProcessNotificationBatchV1 = deepFreeze({
        version: 1, batchId: input.batchId, sessionScopeId: this.sessionScopeId, epochId: input.epochId,
        reason: input.reason, mode: "minimal-continuation", createdAt: timestamp(input.createdAt, "minimal continuation createdAt"),
        items: frozen.map((binding) => structuredClone(binding.minimalItem)),
      });
      try { formatProcessNotificationBatchV1(batch, { maxBytes: this.limits.batchBytes, maxExcerptBytes: 0 }); }
      catch (error) { if (error instanceof NotificationFormattingErrorV1) fail("invalid-fact", error.message); throw error; }
      const prepared: MutablePrepared = {
        batchId: input.batchId, target: structuredClone(input.target), lane,
        windowId: `minimal-${this.nextWindow++}`, epochId: input.epochId, reason: input.reason,
        mode: "minimal-continuation", createdAt: input.createdAt, itemKeys: [],
        leaseWakeTransactionIds: transactionIds, batch, settled: false,
      };
      this.prepared.set(input.batchId, prepared);
      this.counters.batchesPrepared++; this.revision++; this.assertCapacity();
      return deepFreeze({ batch, leaseWakeTransactionIds: transactionIds });
    });
  }

  getPrepared(batchId: string): PreparedNotificationBatchV1 | undefined {
    nonempty(batchId, "batch ID", 256);
    const prepared = this.prepared.get(batchId);
    return prepared ? deepFreeze({ batch: structuredClone(prepared.batch), leaseWakeTransactionIds: [...prepared.leaseWakeTransactionIds] }) : undefined;
  }

  commit(batchId: string): void {
    this.atomic(() => this.commitPrepared(batchId));
  }

  private commitPrepared(batchId: string): void {
    const prepared = this.prepared.get(batchId);
    if (!prepared) this.batchMissing(batchId);
    for (const id of prepared.itemKeys) this.items.delete(id);
    const overflow = this.overflows.get(targetKey(prepared.target));
    if (overflow) {
      overflow.prepared = overflow.prepared.filter((summary) => summary.lane !== prepared.lane);
      if (overflow.prepared.length === 0 && overflow.open.length === 0) this.overflows.delete(targetKey(prepared.target));
    }
    this.prepared.delete(batchId);
    this.recordSettledBatch(batchId, "committed");
    for (const [transactionId, binding] of this.standaloneWakeBindings) {
      if (binding.batchId === batchId) this.standaloneWakeBindings.set(transactionId, { ...binding, phase: "batch-committed" });
    }
    this.counters.batchesCommitted++; this.revision++; this.recomputeCommittedFences(); this.assertCapacity();
  }

  rollback(batchId: string, reason: string): void {
    this.atomic(() => this.rollbackPrepared(batchId, reason));
  }

  discardPreparedWindow(batchId: string, reason: string): void {
    this.atomic(() => {
      nonempty(reason, "discard reason");
      const prepared = this.prepared.get(batchId);
      if (!prepared) this.batchMissing(batchId);
      for (const itemKey of prepared.itemKeys) this.items.delete(itemKey);
      const overflow = this.overflows.get(targetKey(prepared.target));
      if (overflow) {
        overflow.prepared = overflow.prepared.filter((summary) => summary.lane !== prepared.lane);
        if (overflow.open.length === 0 && overflow.prepared.length === 0) this.overflows.delete(targetKey(prepared.target));
      }
      this.prepared.delete(batchId);
      for (const [transactionId, binding] of this.standaloneWakeBindings) {
        if (binding.batchId === batchId) this.standaloneWakeBindings.set(transactionId, { ...binding, phase: "unbound", batchId: undefined });
      }
      this.recordSettledBatch(batchId, "rolled-back");
      this.counters.batchesRolledBack++; this.revision++; this.applyPressure(); this.recomputeCommittedFences(); this.assertCapacity();
    });
  }

  private rollbackPrepared(batchId: string, reason: string): void {
    nonempty(reason, "rollback reason");
    const prepared = this.prepared.get(batchId);
    if (!prepared) this.batchMissing(batchId);
    const pkey = partitionKey(prepared.target, prepared.lane);
    let windowId = this.openWindows.get(pkey);
    if (prepared.itemKeys.length > 0 && !windowId) { windowId = `window-${this.nextWindow++}`; this.openWindows.set(pkey, windowId); }
    for (const oldId of prepared.itemKeys) {
      if (!windowId) fail("state-corrupt", "prepared broker items have no rollback window");
      const item = this.items.get(oldId); if (!item) continue;
      this.items.delete(oldId);
      const nextId = itemId(windowId, item.key);
      const moved = { ...cloneItem(item), windowId };
      const existing = this.items.get(nextId);
      this.items.set(nextId, existing ? this.mergeSnapshots(moved, existing) : moved);
    }
    const overflow = this.overflows.get(targetKey(prepared.target));
    if (overflow) {
      const preparedOverflow = overflow.prepared.find((summary) => summary.lane === prepared.lane);
      if (preparedOverflow) {
        overflow.prepared = overflow.prepared.filter((summary) => summary !== preparedOverflow);
        const open = overflow.open.find((summary) => summary.lane === prepared.lane);
        overflow.open = overflow.open.filter((summary) => summary !== open);
        overflow.open.push(this.mergeOverflow(preparedOverflow, open));
      }
    }
    this.prepared.delete(batchId);
    for (const [transactionId, binding] of this.standaloneWakeBindings) {
      if (binding.batchId === batchId) this.standaloneWakeBindings.set(transactionId, { ...binding, phase: "unbound", batchId: undefined });
    }
    this.recordSettledBatch(batchId, "rolled-back");
    this.counters.batchesRolledBack++; this.revision++; this.applyPressure(); this.recomputeCommittedFences(); this.assertCapacity();
  }

  ackLeaseWakeTransaction(transactionId: string): void {
    this.atomic(() => this.ackLease(transactionId));
  }

  private ackLease(transactionId: string): void {
    nonempty(transactionId, "lease transaction ID", 256);
    this.requireTransactionMutable(transactionId, "lease");
    if ([...this.prepared.values()].some((entry) => entry.leaseWakeTransactionIds.includes(transactionId))) {
      fail("invalid-fact", "lease transaction is bound to a prepared batch");
    }
    if (!this.leaseWakeBindings.delete(transactionId)) fail("invalid-fact", "lease transaction is not pending");
    for (const [id, item] of this.items) {
      if (!item.leaseWakeTransactionIds.includes(transactionId)) continue;
      this.items.set(id, { ...cloneItem(item), leaseWakeTransactionIds: item.leaseWakeTransactionIds.filter((value) => value !== transactionId) });
    }
    for (const overflow of this.overflows.values()) {
      for (const summary of overflow.open) summary.leaseWakeTransactionIds = summary.leaseWakeTransactionIds.filter((value) => value !== transactionId);
    }
    this.revision++; this.recomputeCommittedFences(); this.assertCapacity();
  }

  pendingTuiDeliveries(target?: NotificationTargetV1): readonly TuiDeliveryRecordSnapshotV1[] {
    if (target) validateTarget(target);
    return deepFreeze([...this.tuiDeliveries.values()]
      .filter((entry) => entry.state === "pending" && (!target || targetKey(entry.target) === targetKey(target)))
      .map((entry) => structuredClone(entry))
      .sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)));
  }

  ackTuiDelivery(deliveryId: string): void {
    this.atomic(() => {
      nonempty(deliveryId, "TUI delivery ID", 1024);
      const entry = this.tuiDeliveries.get(deliveryId);
      if (!entry) fail("invalid-fact", "TUI delivery does not exist");
      if (entry.state === "recorded") fail("invalid-fact", "TUI delivery is already recorded");
      const { entry: _entry, ...tombstone } = entry;
      this.tuiDeliveries.set(deliveryId, { ...tombstone, state: "recorded" });
      this.revision++; this.assertCapacity();
    });
  }

  pendingLeaseArtifacts(target?: NotificationTargetV1): readonly Readonly<{ transactionId: string; artifact: LeaseWakeBindingSnapshotV1["artifact"] }>[] {
    if (target) validateTarget(target);
    return deepFreeze([...this.leaseWakeBindings.values()]
      .filter((binding) => binding.artifact.state === "pending" && (!target || sameTarget(binding.target, target)))
      .map((binding) => ({ transactionId: binding.transactionId, artifact: structuredClone(binding.artifact) }))
      .sort((a, b) => a.transactionId.localeCompare(b.transactionId)));
  }

  ackLeaseArtifact(transactionId: string): void {
    this.atomic(() => {
      nonempty(transactionId, "lease transaction ID", 256);
      this.requireTransactionMutable(transactionId, "lease");
      const binding = this.leaseWakeBindings.get(transactionId);
      if (!binding) fail("invalid-fact", "lease transaction is not pending");
      if (binding.artifact.state === "recorded") return;
      this.leaseWakeBindings.set(transactionId, {
        ...binding,
        artifact: { ...binding.artifact, state: "recorded" },
      });
      this.revision++;
      this.assertCapacity();
    });
  }

  bindStandaloneWake(batchId: string, input: { readonly transactionId: string; readonly claimed: boolean }): void {
    this.atomic(() => {
      const object = inputObject(input, "standalone wake input"); exactInput(object, ["transactionId", "claimed"], [], "standalone wake input");
      nonempty(batchId, "batch ID", 256); nonempty(input.transactionId, "standalone transaction ID", 256); inputBoolean(input.claimed, "standalone claimed");
      if (this.settledStandaloneWakes.has(input.transactionId)) fail("invalid-fact", "standalone transaction is already settled");
      const prepared = this.prepared.get(batchId);
      if (!prepared || prepared.lane !== "turn") fail("invalid-fact", "standalone transaction requires a prepared turn batch");
      this.requireTargetActive(prepared.target);
      const existing = this.standaloneWakeBindings.get(input.transactionId);
      if ([...this.standaloneWakeBindings.values()].some((binding) => binding.batchId === batchId && binding.transactionId !== input.transactionId)) fail("invalid-fact", "prepared batch already has a standalone transaction");
      if (existing) {
        if (!sameTarget(existing.target, prepared.target) || existing.claimed !== input.claimed || (existing.batchId && existing.batchId !== batchId)) fail("invalid-fact", "standalone transaction cannot be rebound");
        this.standaloneWakeBindings.set(input.transactionId, { ...existing, phase: "batch-prepared", batchId });
      } else {
        this.standaloneWakeBindings.set(input.transactionId, { transactionId: input.transactionId, target: structuredClone(prepared.target), lane: "turn", phase: "batch-prepared", batchId, claimed: input.claimed });
      }
      this.revision++; this.assertCapacity();
    });
  }

  settleStandaloneWake(transactionId: string, outcome: "delivered" | "skipped"): void {
    this.atomic(() => {
      this.requireTransactionMutable(transactionId, "standalone");
      this.finishStandaloneWake(transactionId, enumValue(outcome, ["delivered", "skipped"] as const, "standalone outcome"));
    });
  }

  abortStandaloneWake(transactionId: string, reason: string): void {
    this.atomic(() => {
      nonempty(reason, "standalone abort reason");
      this.requireTransactionMutable(transactionId, "standalone");
      this.finishStandaloneWake(transactionId, "aborted");
    });
  }

  clearProcess(processId: string): void {
    this.atomic(() => {
      nonempty(processId, "process ID", 256);
      this.requireProcessMutable(processId);
      for (const [key, watch] of this.watches) if (watch.processId === processId) this.watches.delete(key);
      this.terminalProcesses.delete(processId);
      for (const [key, delivery] of this.tuiDeliveries) if (delivery.processId === processId) this.tuiDeliveries.delete(key);
      if (!this.processHasRetainedState(processId)) this.processOwners.delete(processId);
      this.revision++; this.assertCapacity();
    });
  }

  beginRetireTarget(retirementId: string, target: NotificationTargetV1): RetirementPlanV1 {
    return this.atomic(() => {
      nonempty(retirementId, "retirement ID", 256); validateTarget(target);
      const existing = this.retirementPlans.get(retirementId);
      if (existing) {
        if (existing.kind !== "target" || !existing.target || !sameTarget(existing.target, target)) fail("invalid-fact", "retirement ID is already used");
        return deepFreeze(structuredClone(existing));
      }
      if ([...this.retirementPlans.values()].some((entry) => entry.kind === "scope" || (entry.target && sameTarget(entry.target, target)))) fail("invalid-fact", "target is already retiring");
      const key = targetKey(target);
      if ([...this.prepared.values()].some((entry) => targetKey(entry.target) === key)) fail("prepare-in-progress", "target has a prepared batch");
      if (this.retirementPlans.size >= this.limits.retirementPlans) fail("capacity", "retirement plan capacity is exhausted");
      const plan: RetirementPlanV1 = {
        retirementId, kind: "target", target: structuredClone(target), state: "pending",
        processIds: [...this.processOwners.entries()].filter(([, owner]) => targetKey(owner) === key).map(([processId]) => processId).sort(),
        leaseWakeTransactionIds: [...this.leaseWakeBindings.values()].filter((entry) => targetKey(entry.target) === key).map((entry) => entry.transactionId).sort(),
        standaloneWakeTransactionIds: [...this.standaloneWakeBindings.values()].filter((entry) => targetKey(entry.target) === key).map((entry) => entry.transactionId).sort(),
      };
      this.retirementPlans.set(retirementId, plan); this.revision++; this.assertCapacity();
      return deepFreeze(structuredClone(plan));
    });
  }

  beginDisposeScope(retirementId: string): RetirementPlanV1 {
    return this.atomic(() => {
      nonempty(retirementId, "retirement ID", 256);
      const existing = this.retirementPlans.get(retirementId);
      if (existing) { if (existing.kind !== "scope") fail("invalid-fact", "retirement ID is already used"); return deepFreeze(structuredClone(existing)); }
      if (this.retirementPlans.size > 0 || this.prepared.size > 0) fail("prepare-in-progress", "scope has active delivery or retirement state");
      const plan: RetirementPlanV1 = {
        retirementId, kind: "scope", state: "pending",
        processIds: [...this.processOwners.keys()].sort(),
        leaseWakeTransactionIds: [...this.leaseWakeBindings.keys()].sort(),
        standaloneWakeTransactionIds: [...this.standaloneWakeBindings.keys()].sort(),
      };
      this.retirementPlans.set(retirementId, plan); this.revision++; this.assertCapacity();
      return deepFreeze(structuredClone(plan));
    });
  }

  pendingRetirements(): readonly RetirementPlanV1[] {
    return deepFreeze([...this.retirementPlans.values()].map((entry) => structuredClone(entry)).sort((a, b) => a.retirementId.localeCompare(b.retirementId)));
  }

  ackRetirement(retirementId: string): void {
    this.atomicRetirement(() => {
      nonempty(retirementId, "retirement ID", 256);
      const plan = this.retirementPlans.get(retirementId);
      if (!plan) fail("invalid-fact", "retirement does not exist");
      if (plan.kind === "target") this.deleteTargetState(plan.target!);
      else {
        this.items.clear(); this.prepared.clear(); this.openWindows.clear(); this.overflows.clear(); this.processOwners.clear(); this.watches.clear(); this.terminalProcesses.clear();
        this.leaseWakeBindings.clear(); this.standaloneWakeBindings.clear(); this.tuiDeliveries.clear(); this.disposed = true;
      }
      this.retirementPlans.delete(retirementId); this.revision++; this.recomputeCommittedFences(); this.assertCapacity();
    });
  }

  notificationSnapshot(): ProcessNotificationSnapshotV1 {
    const watches = [...this.watches.values()].map((value) => structuredClone(value)).sort((a, b) => a.processId.localeCompare(b.processId) || a.key.localeCompare(b.key) || a.generation - b.generation);
    return deepFreeze({ version: 1, revision: this.revision, watches });
  }
  healthSnapshot(): NotificationBrokerHealthV1 {
    const state = this.exportState(); const slots = this.slotCounts();
    return deepFreeze({
      revision: this.revision,
      degraded: this.degraded,
      slots,
      serializedBytes: measureNotificationBrokerStateV1(state),
      controlPlaneBindings: state.leaseWakeBindings.length + state.standaloneWakeBindings.length,
      controlPlaneSerializedBytes: measureNotificationControlPlaneStateV1(state),
      tuiDeliveryRecords: state.tuiDeliveries.length,
      tuiDeliverySerializedBytes: measureNotificationTuiDeliveryStateV1(state),
      pendingRetirements: state.pendingRetirements.length,
      modelTargetPartitions: this.modelTargetCount(),
      counters: { ...this.counters },
    });
  }
  exportState(): NotificationBrokerStateV1 {
    const state: NotificationBrokerStateV1 = {
      version: 1, sessionScopeId: this.sessionScopeId, revision: this.revision, degraded: this.degraded,
      sourceFences: [...this.fences.values()].map((value) => ({ ...value })).sort((a, b) => a.hostIncarnationId.localeCompare(b.hostIncarnationId)),
      items: [...this.items.values()].map(cloneItem).sort((a, b) => a.windowId.localeCompare(b.windowId) || itemOrder(a, b)),
      prepared: [...this.prepared.values()].map((value) => ({ ...structuredClone(value), itemKeys: [...value.itemKeys].sort() })).sort((a, b) => a.batchId.localeCompare(b.batchId)),
      openWindows: [...this.openWindows.entries()].map(([key, windowId]) => { const [strategy, scopeToken, lane] = JSON.parse(key) as ["main" | "child", string, NotificationLaneV1]; return { target: { strategy, scopeToken }, lane, windowId }; }).sort((a, b) => partitionKey(a.target, a.lane).localeCompare(partitionKey(b.target, b.lane))),
      overflows: [...this.overflows.values()].map((value) => ({
        target: structuredClone(value.target),
        prepared: value.prepared.map((summary) => this.exportOverflow(summary)).sort((a, b) => a.lane.localeCompare(b.lane)),
        open: value.open.map((summary) => this.exportOverflow(summary)).sort((a, b) => a.lane.localeCompare(b.lane)),
      })).sort((a, b) => targetKey(a.target).localeCompare(targetKey(b.target))),
      processOwners: [...this.processOwners.entries()].map(([processId, owner]) => ({ processId, target: structuredClone(owner) })).sort((a, b) => a.processId.localeCompare(b.processId)),
      watches: [...this.watches.values()].map((value) => structuredClone(value)).sort((a, b) => watchSnapshotKey(a.processId, a.key, a.generation).localeCompare(watchSnapshotKey(b.processId, b.key, b.generation))),
      terminalProcesses: [...this.terminalProcesses.entries()].map(([processId, factId]) => ({ processId, factId })).sort((a, b) => a.processId.localeCompare(b.processId)),
      leaseWakeBindings: [...this.leaseWakeBindings.values()].map((binding) => structuredClone(binding)).sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
      standaloneWakeBindings: [...this.standaloneWakeBindings.values()].map((binding) => structuredClone(binding)).sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
      settledStandaloneWakes: [...this.settledStandaloneWakes.entries()].map(([transactionId, outcome]) => ({ transactionId, outcome })),
      tuiDeliveries: [...this.tuiDeliveries.values()].map((delivery) => structuredClone(delivery)).sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)),
      pendingRetirements: [...this.retirementPlans.values()].map((plan) => structuredClone(plan)).sort((a, b) => a.retirementId.localeCompare(b.retirementId)),
      settledBatches: [...this.settledBatches.entries()].map(([batchId, outcome]) => ({ batchId, outcome })),
      disposed: this.disposed,
      counters: { ...this.counters },
    };
    return deepFreeze(state);
  }

  private newItem(key: string, windowId: string, lane: NotificationLaneV1, input: ObserveNotificationInputV1): BrokerItemSnapshotV1 {
    const { fact } = input; const amount = fact.watch?.count ?? 1;
    return {
      key, windowId, target: structuredClone(input.target), lane,
      firstFactId: fact.factId, lastFactId: fact.factId, hostIncarnationId: fact.source.hostIncarnationId,
      firstNotificationSequence: fact.source.notificationSequence, lastNotificationSequence: fact.source.notificationSequence,
      firstObservedAt: fact.observedAt, lastObservedAt: fact.observedAt, count: amount,
      ...(fact.kind === "watch-match" ? { matchedCount: amount, suppressedCount: 0 } : {}),
      ...(fact.kind === "watch-suppressed" ? { matchedCount: 0, suppressedCount: amount } : {}),
      identity: {
        kind: fact.kind === "watch-suppressed" ? "watch-match" : fact.kind, attention: fact.attention,
        ...(fact.process ? { process: structuredClone(fact.process) } : {}),
        ...(fact.stableCode ? { stableCode: fact.stableCode } : {}), ...(fact.correlationId ? { correlationId: fact.correlationId } : {}),
        ...(fact.watch ? { watch: watchIdentity(fact.watch) } : {}),
        ...(fact.terminal ? { terminal: structuredClone(fact.terminal) } : {}),
      },
      ...(fact.excerpt ? { latestExcerptRef: structuredClone(fact.excerpt) } : {}),
      leaseWakeTransactionIds: input.leaseWakeTransactionId ? [input.leaseWakeTransactionId] : [],
    };
  }
  private mergeItem(existing: BrokerItemSnapshotV1, input: ObserveNotificationInputV1): BrokerItemSnapshotV1 {
    const fact = input.fact; const amount = fact.watch?.count ?? 1;
    return {
      ...cloneItem(existing), lastFactId: fact.factId, lastNotificationSequence: fact.source.notificationSequence,
      lastObservedAt: fact.observedAt, count: existing.count + amount,
      ...(existing.matchedCount === undefined ? {} : { matchedCount: existing.matchedCount + (fact.kind === "watch-match" ? amount : 0) }),
      ...(existing.suppressedCount === undefined ? {} : { suppressedCount: existing.suppressedCount + (fact.kind === "watch-suppressed" ? amount : 0) }),
      ...(fact.excerpt ? { latestExcerptRef: structuredClone(fact.excerpt) } : {}),
      leaseWakeTransactionIds: [...new Set([...existing.leaseWakeTransactionIds, ...(input.leaseWakeTransactionId ? [input.leaseWakeTransactionId] : [])])].sort(),
    };
  }
  private mergeSnapshots(first: BrokerItemSnapshotV1, second: BrokerItemSnapshotV1): BrokerItemSnapshotV1 {
    const earlier = itemOrder(first, second) <= 0 ? first : second; const later = earlier === first ? second : first;
    return {
      ...cloneItem(earlier), windowId: second.windowId, lastFactId: later.lastFactId,
      lastNotificationSequence: later.lastNotificationSequence, lastObservedAt: later.lastObservedAt,
      count: first.count + second.count,
      ...((first.matchedCount ?? second.matchedCount) === undefined ? {} : { matchedCount: (first.matchedCount ?? 0) + (second.matchedCount ?? 0) }),
      ...((first.suppressedCount ?? second.suppressedCount) === undefined ? {} : { suppressedCount: (first.suppressedCount ?? 0) + (second.suppressedCount ?? 0) }),
      ...(later.latestExcerptRef ? { latestExcerptRef: later.latestExcerptRef } : {}),
      leaseWakeTransactionIds: [...new Set([...first.leaseWakeTransactionIds, ...second.leaseWakeTransactionIds])].sort(),
    };
  }
  private observeWatch(fact: ObserveNotificationInputV1["fact"]): void {
    if (!fact.watch || !fact.process || (fact.kind !== "watch-match" && fact.kind !== "watch-suppressed")) return;
    const key = watchSnapshotKey(fact.process.id, fact.watch.key, fact.watch.generation);
    const prior = this.watches.get(key); const amount = fact.watch.count;
    this.watches.set(key, {
      processId: fact.process.id, key: fact.watch.key, generation: fact.watch.generation,
      matchedCount: (prior?.matchedCount ?? 0) + (fact.kind === "watch-match" ? amount : 0),
      suppressedCount: (prior?.suppressedCount ?? 0) + (fact.kind === "watch-suppressed" ? amount : 0),
      firstSequence: prior ? Math.min(prior.firstSequence, fact.watch.firstSequence) : fact.watch.firstSequence,
      lastSequence: prior ? Math.max(prior.lastSequence, fact.watch.lastSequence) : fact.watch.lastSequence,
      lastObservedAt: fact.observedAt,
    });
  }
  private observeTuiDelivery(input: ObserveNotificationInputV1): { disposition: ObserveNotificationResultV1["tuiDisposition"]; deliveryId?: string } {
    const identity = tuiIdentity(input);
    if (!identity) {
      if (input.tuiEntry !== undefined) fail("invalid-fact", "notification without TUI identity cannot include a TUI entry");
      return { disposition: "aggregate-only" };
    }
    if (!input.tuiEntry) fail("invalid-fact", "notification with TUI identity requires an immutable TUI entry");
    const deliveryId = tuiDeliveryId(input.target, identity);
    const existing = this.tuiDeliveries.get(deliveryId);
    const amount = input.fact.watch?.count ?? 1;
    if (existing) {
      this.tuiDeliveries.set(deliveryId, { ...existing, lastFactId: input.fact.factId, count: existing.count + amount });
      return existing.state === "recorded" ? { disposition: "aggregate-only", deliveryId } : { disposition: "append", deliveryId };
    }
    if (this.tuiDeliveries.size >= this.limits.tuiDeliveryRecords) {
      this.counters.tuiDeliveriesDropped++;
      return { disposition: "none" };
    }
    const next: TuiDeliveryRecordSnapshotV1 = {
      deliveryId,
      identity: structuredClone(identity),
      target: structuredClone(input.target),
      ...(input.fact.process ? { processId: input.fact.process.id } : {}),
      firstFactId: input.fact.factId,
      lastFactId: input.fact.factId,
      count: amount,
      state: "pending",
      entry: structuredClone(input.tuiEntry),
    };
    const previous = this.tuiDeliveries.get(deliveryId);
    this.tuiDeliveries.set(deliveryId, next);
    if (measureNotificationTuiDeliveryStateV1(this.exportState()) > this.limits.tuiDeliveryBytes) {
      if (previous) this.tuiDeliveries.set(deliveryId, previous); else this.tuiDeliveries.delete(deliveryId);
      this.counters.tuiDeliveriesDropped++;
      return { disposition: "none" };
    }
    return { disposition: "append", deliveryId };
  }

  private processHasRetainedState(processId: string): boolean {
    return [...this.items.values()].some((item) => item.identity.process?.id === processId)
      || [...this.prepared.values()].some((prepared) => prepared.batch.items.some((item) => item.processId === processId))
      || [...this.leaseWakeBindings.values()].some((binding) => binding.minimalItem.processId === processId)
      || [...this.tuiDeliveries.values()].some((delivery) => delivery.processId === processId);
  }

  private deleteTargetState(target: NotificationTargetV1): void {
    const key = targetKey(target);
    const processIds = [...this.processOwners.entries()].filter(([, owner]) => targetKey(owner) === key).map(([processId]) => processId);
    const ownedProcesses = new Set(processIds);
    for (const [id, item] of this.items) if (targetKey(item.target) === key) this.items.delete(id);
    for (const [partition] of this.openWindows) if (partitionBelongsToTarget(partition, target)) this.openWindows.delete(partition);
    this.overflows.delete(key);
    for (const [watchKey, watch] of this.watches) if (ownedProcesses.has(watch.processId)) this.watches.delete(watchKey);
    for (const processId of processIds) { this.terminalProcesses.delete(processId); this.processOwners.delete(processId); }
    for (const [id, delivery] of this.tuiDeliveries) if (targetKey(delivery.target) === key) this.tuiDeliveries.delete(id);
    for (const [id, binding] of this.leaseWakeBindings) if (targetKey(binding.target) === key) this.leaseWakeBindings.delete(id);
    for (const [id, binding] of this.standaloneWakeBindings) if (targetKey(binding.target) === key) this.standaloneWakeBindings.delete(id);
  }

  private finishStandaloneWake(transactionId: string, outcome: SettledStandaloneWakeSnapshotV1["outcome"]): void {
    nonempty(transactionId, "standalone transaction ID", 256);
    if (this.settledStandaloneWakes.has(transactionId)) fail("invalid-fact", "standalone transaction is already settled");
    const binding = this.standaloneWakeBindings.get(transactionId);
    if (!binding) fail("invalid-fact", "standalone transaction does not exist");
    if (binding.phase !== "batch-committed" || !binding.batchId || this.settledBatches.get(binding.batchId) !== "committed") {
      fail("invalid-fact", "standalone transaction batch is not committed");
    }
    this.standaloneWakeBindings.delete(transactionId);
    this.settledStandaloneWakes.set(transactionId, outcome);
    while (this.settledStandaloneWakes.size > SETTLED_STANDALONE_WAKE_LIMIT) this.settledStandaloneWakes.delete(this.settledStandaloneWakes.keys().next().value as string);
    this.revision++; this.assertCapacity();
  }
  private hasModelPartition(target: NotificationTargetV1): boolean {
    const key = targetKey(target);
    if ([...this.items.values()].some((item) => targetKey(item.target) === key)
      || [...this.prepared.values()].some((item) => item.mode !== "minimal-continuation" && targetKey(item.target) === key)
      || this.overflows.has(key)) return true;
    return this.modelTargetCount() < this.limits.modelTargetPartitions;
  }
  private modelTargetCount(): number {
    const keys = new Set<string>();
    for (const item of this.items.values()) keys.add(targetKey(item.target));
    for (const prepared of this.prepared.values()) if (prepared.mode !== "minimal-continuation") keys.add(targetKey(prepared.target));
    for (const key of this.overflows.keys()) keys.add(key);
    return keys.size;
  }
  private slotCounts(): { general: number; terminal: number; overflow: number; total: number } {
    let general = 0, terminal = 0;
    for (const item of this.items.values()) item.identity.kind === "terminal" ? terminal++ : general++;
    const overflow = this.overflows.size; return { general, terminal, overflow, total: general + terminal + overflow };
  }
  applyPressure(): void {
    for (;;) {
      const slots = this.slotCounts(); const bytes = measureNotificationBrokerStateV1(this.exportState());
      if (slots.general <= this.limits.generalSlots && slots.terminal <= this.limits.terminalSlots && slots.total <= this.limits.totalSlots && bytes <= this.limits.serializedBytes) return;
      const excerpt = [...this.items.entries()].filter(([, item]) => item.identity.kind !== "terminal" && item.latestExcerptRef && !this.isPreparedItem(item)).sort((a, b) => itemOrder(a[1], b[1]))[0];
      if (excerpt) { this.items.set(excerpt[0], { ...cloneItem(excerpt[1]), latestExcerptRef: undefined }); continue; }
      const general = [...this.items.entries()].filter(([, item]) => item.identity.kind !== "terminal" && !this.isPreparedItem(item)).sort((a, b) => itemOrder(a[1], b[1]))[0];
      const terminal = [...this.items.entries()].filter(([, item]) => item.identity.kind === "terminal" && !this.isPreparedItem(item)).sort((a, b) => itemOrder(a[1], b[1]))[0];
      const candidate = slots.terminal > this.limits.terminalSlots
        ? terminal
        : slots.general > this.limits.generalSlots
          ? general
          : general ?? terminal;
      if (!candidate) fail("capacity", "notification broker cannot satisfy capacity without mutating prepared state");
      this.foldIntoOverflow(candidate[0], candidate[1]);
    }
  }
  private isPreparedItem(item: BrokerItemSnapshotV1): boolean { return [...this.prepared.values()].some((prepared) => prepared.itemKeys.includes(itemId(item.windowId, item.key))); }
  private foldIntoOverflow(id: string, item: BrokerItemSnapshotV1): void {
    const key = targetKey(item.target); let overflow = this.overflows.get(key);
    if (!overflow) {
      if (this.overflows.size >= this.limits.targetOverflowSlots) fail("capacity", "notification target overflow capacity is exhausted");
      overflow = { target: structuredClone(item.target), prepared: [], open: [] }; this.overflows.set(key, overflow);
    }
    this.items.delete(id); this.counters.itemsOverflowed += item.count;
    let summary = overflow.open.find((value) => value.lane === item.lane);
    if (!summary) {
      summary = { lane: item.lane, omittedItems: 0, byKind: {}, sourceRanges: [], leaseWakeTransactionIds: [] };
      overflow.open.push(summary);
    }
    summary.omittedItems += item.count;
    summary.byKind[item.identity.kind] = (summary.byKind[item.identity.kind] ?? 0) + item.count;
    summary.leaseWakeTransactionIds = [...new Set([...summary.leaseWakeTransactionIds, ...item.leaseWakeTransactionIds])].sort();
    this.addSourceRange(summary.sourceRanges, item.hostIncarnationId, item.firstNotificationSequence, item.lastNotificationSequence);
  }
  private addSourceRange(ranges: OverflowSourceRangeV1[], hostIncarnationId: string, first: number, last: number): void {
    let nextFirst = first;
    let nextLast = last;
    const retained: OverflowSourceRangeV1[] = [];
    for (const range of ranges) {
      if (range.hostIncarnationId !== hostIncarnationId || range.lastNotificationSequence + 1 < nextFirst || nextLast + 1 < range.firstNotificationSequence) {
        retained.push(range);
        continue;
      }
      nextFirst = Math.min(nextFirst, range.firstNotificationSequence);
      nextLast = Math.max(nextLast, range.lastNotificationSequence);
    }
    retained.push({ hostIncarnationId, firstNotificationSequence: nextFirst, lastNotificationSequence: nextLast });
    retained.sort((a, b) => a.hostIncarnationId.localeCompare(b.hostIncarnationId) || a.firstNotificationSequence - b.firstNotificationSequence);
    ranges.splice(0, ranges.length, ...retained);
  }
  private mergeOverflow(first: MutableOverflowSummary, second?: MutableOverflowSummary): MutableOverflowSummary {
    const result = cloneOverflowSummary(first);
    if (second) {
      result.omittedItems += second.omittedItems;
      for (const [kind, count] of Object.entries(second.byKind)) result.byKind[kind] = (result.byKind[kind] ?? 0) + count;
      for (const range of second.sourceRanges) this.addSourceRange(result.sourceRanges, range.hostIncarnationId, range.firstNotificationSequence, range.lastNotificationSequence);
      result.leaseWakeTransactionIds = [...new Set([...result.leaseWakeTransactionIds, ...second.leaseWakeTransactionIds])].sort();
    }
    return result;
  }
  private exportOverflow(summary: MutableOverflowSummary): OverflowSummaryV1 {
    return {
      lane: summary.lane,
      omittedItems: summary.omittedItems,
      byKind: Object.fromEntries(Object.entries(summary.byKind).sort(([a], [b]) => a.localeCompare(b))),
      sourceRanges: summary.sourceRanges.map((range) => ({ ...range })).sort((a, b) => a.hostIncarnationId.localeCompare(b.hostIncarnationId) || a.firstNotificationSequence - b.firstNotificationSequence),
      leaseWakeTransactionIds: [...summary.leaseWakeTransactionIds].sort(),
    };
  }
  private leaseIdsForPrepared(prepared: Pick<MutablePrepared, "target">, items: readonly BrokerItemSnapshotV1[], overflow?: MutableOverflowSummary): string[] {
    const itemIds = items.flatMap((item) => item.leaseWakeTransactionIds);
    const overflowIds = overflow?.leaseWakeTransactionIds ?? [];
    return [...new Set([...itemIds, ...overflowIds])].sort();
  }
  private recordSettledBatch(batchId: string, outcome: SettledBatchSnapshotV1["outcome"]): void {
    this.settledBatches.set(batchId, outcome);
    while (this.settledBatches.size > SETTLED_BATCH_LIMIT) {
      const retained = new Set([...this.standaloneWakeBindings.values()].map((binding) => binding.batchId).filter((value): value is string => value !== undefined));
      const candidate = [...this.settledBatches.keys()].find((id) => !retained.has(id));
      if (!candidate) fail("capacity", "settled batch ledger is pinned by standalone transactions");
      this.settledBatches.delete(candidate);
    }
  }
  private unresolvedSequences(hostIncarnationId: string): number[] {
    const sequences = [...this.items.values()].filter((item) => item.hostIncarnationId === hostIncarnationId).map((item) => item.firstNotificationSequence);
    for (const overflow of this.overflows.values()) for (const summary of [...overflow.prepared, ...overflow.open]) {
      for (const range of summary.sourceRanges) if (range.hostIncarnationId === hostIncarnationId) sequences.push(range.firstNotificationSequence);
    }
    for (const binding of this.leaseWakeBindings.values()) if (binding.hostIncarnationId === hostIncarnationId) sequences.push(binding.notificationSequence);
    return sequences;
  }
  recomputeCommittedFences(): void {
    for (const fence of this.fences.values()) {
      const unsettled = this.unresolvedSequences(fence.hostIncarnationId);
      fence.highestCommittedNotificationSequence = unsettled.length === 0
        ? fence.highestObservedNotificationSequence
        : Math.max(0, Math.min(...unsettled) - 1);
    }
  }
  assertCapacity(): void {
    const state = this.exportState();
    const slots = this.slotCounts();
    const bytes = measureNotificationBrokerStateV1(state);
    const controlBytes = measureNotificationControlPlaneStateV1(state);
    const tuiBytes = measureNotificationTuiDeliveryStateV1(state);
    if (slots.general > this.limits.generalSlots || slots.terminal > this.limits.terminalSlots || slots.overflow > this.limits.targetOverflowSlots || slots.total > this.limits.totalSlots || bytes > this.limits.serializedBytes) fail("capacity", "notification broker exceeds fixed model capacity");
    if (state.leaseWakeBindings.length + state.standaloneWakeBindings.length > this.limits.controlPlaneBindings || state.pendingRetirements.length > this.limits.retirementPlans || controlBytes > this.limits.controlPlaneBytes) fail("capacity", "notification broker exceeds fixed control-plane capacity");
    if (state.tuiDeliveries.length > this.limits.tuiDeliveryRecords || tuiBytes > this.limits.tuiDeliveryBytes) fail("capacity", "notification broker exceeds fixed TUI delivery capacity");
  }
  private batchMissing(batchId: string): never { return this.settledBatches.has(batchId) ? fail("batch-already-settled", "batch is already settled") : fail("batch-not-found", "batch does not exist"); }
  loadState(state: NotificationBrokerStateV1): void {
    validateBrokerState(state, this.sessionScopeId, this.limits);
    this.revision = state.revision; this.degraded = state.degraded;
    this.fences = new Map(state.sourceFences.map((value) => [value.hostIncarnationId, { ...value }]));
    this.items = new Map(state.items.map((value) => [itemId(value.windowId, value.key), cloneItem(value)]));
    this.prepared = new Map(state.prepared.map((value) => [value.batchId, { ...structuredClone(value), itemKeys: [...value.itemKeys] }]));
    this.openWindows = new Map(state.openWindows.map((value) => [partitionKey(value.target, value.lane), value.windowId]));
    this.overflows = new Map(state.overflows.map((value) => [targetKey(value.target), {
      target: structuredClone(value.target),
      prepared: value.prepared.map(cloneOverflowSummary),
      open: value.open.map(cloneOverflowSummary),
    }]));
    this.processOwners = new Map(state.processOwners.map((value) => [value.processId, structuredClone(value.target)]));
    this.watches = new Map(state.watches.map((value) => [watchSnapshotKey(value.processId, value.key, value.generation), structuredClone(value)]));
    this.terminalProcesses = new Map(state.terminalProcesses.map((value) => [value.processId, value.factId]));
    this.leaseWakeBindings = new Map(state.leaseWakeBindings.map((value) => [value.transactionId, structuredClone(value)]));
    this.standaloneWakeBindings = new Map(state.standaloneWakeBindings.map((value) => [value.transactionId, structuredClone(value)]));
    this.settledStandaloneWakes = new Map(state.settledStandaloneWakes.map((value) => [value.transactionId, value.outcome]));
    this.tuiDeliveries = new Map(state.tuiDeliveries.map((value) => [value.deliveryId, structuredClone(value)]));
    this.retirementPlans = new Map(state.pendingRetirements.map((value) => [value.retirementId, structuredClone(value)]));
    this.settledBatches = new Map(state.settledBatches.map((value) => [value.batchId, value.outcome]));
    this.disposed = state.disposed;
    this.counters = { ...state.counters };
    const ids = [...state.openWindows.map((value) => value.windowId), ...state.prepared.map((value) => value.windowId)].map((id) => Number(id.match(/(\d+)$/)?.[1] ?? 0));
    this.nextWindow = Math.max(0, ...ids) + 1;
  }
}

function validateBrokerState(value: unknown, sessionScopeId: string, limits: NotificationBrokerLimitsV1): asserts value is NotificationBrokerStateV1 {
  const state = plainObject(value, "broker state");
  exact(state, ["version", "sessionScopeId", "revision", "degraded", "sourceFences", "items", "prepared", "openWindows", "overflows", "processOwners", "watches", "terminalProcesses", "leaseWakeBindings", "standaloneWakeBindings", "settledStandaloneWakes", "tuiDeliveries", "pendingRetirements", "settledBatches", "disposed", "counters"], [], "broker state");
  if (state.version !== 1 || state.sessionScopeId !== sessionScopeId) fail("state-corrupt", "notification broker state identity is invalid");
  stateInteger(state.revision, "broker state revision"); bool(state.degraded, "broker degraded"); bool(state.disposed, "broker disposed");
  const fences = array(state.sourceFences, "source fences");
  const fenceIds = new Set<string>();
  const fenceObserved = new Map<string, number>();
  const fenceCommitted = new Map<string, number>();
  for (const [index, raw] of fences.entries()) {
    const item = plainObject(raw, `source fence ${index}`); exact(item, ["hostIncarnationId", "highestObservedNotificationSequence", "highestCommittedNotificationSequence"], [], `source fence ${index}`);
    const id = stateString(item.hostIncarnationId, `source fence ${index} ID`, 256); if (fenceIds.has(id)) fail("state-corrupt", "duplicate source fence"); fenceIds.add(id);
    const observed = stateInteger(item.highestObservedNotificationSequence, "highest observed sequence");
    const committed = stateInteger(item.highestCommittedNotificationSequence, "highest committed sequence");
    if (committed > observed) fail("state-corrupt", "committed sequence exceeds observed sequence");
    fenceObserved.set(id, observed);
    fenceCommitted.set(id, committed);
  }
  const items = array(state.items, "broker items");
  const itemIds = new Set<string>();
  for (const [index, raw] of items.entries()) validateStateItem(raw, index, itemIds, fenceObserved);
  const openWindows = array(state.openWindows, "open windows");
  const openPartitions = new Map<string, string>();
  const allWindowIds = new Set<string>();
  for (const [index, raw] of openWindows.entries()) {
    const entry = plainObject(raw, `open window ${index}`); exact(entry, ["target", "lane", "windowId"], [], `open window ${index}`);
    const target = validateStateTarget(entry.target, `open window ${index} target`);
    const lane = enumValue(entry.lane, ["context", "turn"] as const, `open window ${index} lane`, true);
    const key = partitionKey(target, lane); if (openPartitions.has(key)) fail("state-corrupt", "duplicate open window partition");
    const windowId = stateString(entry.windowId, `open window ${index} ID`); if (allWindowIds.has(windowId)) fail("state-corrupt", "duplicate window ID"); allWindowIds.add(windowId);
    openPartitions.set(key, windowId);
  }
  const prepared = array(state.prepared, "prepared windows");
  const preparedPartitions = new Map<string, string>(); const preparedIds = new Set<string>();
  for (const [index, raw] of prepared.entries()) {
    const entry = plainObject(raw, `prepared window ${index}`);
    exact(entry, ["batchId", "target", "lane", "windowId", "epochId", "reason", "mode", "createdAt", "itemKeys", "leaseWakeTransactionIds", "batch", "settled"], [], `prepared window ${index}`);
    const batchId = stateString(entry.batchId, `prepared window ${index} batch ID`, 256); if (preparedIds.has(batchId)) fail("state-corrupt", "duplicate prepared batch"); preparedIds.add(batchId);
    const target = validateStateTarget(entry.target, `prepared window ${index} target`);
    const lane = enumValue(entry.lane, ["context", "turn"] as const, `prepared window ${index} lane`, true);
    const pkey = partitionKey(target, lane); if (preparedPartitions.has(pkey)) fail("state-corrupt", "duplicate prepared window partition");
    const windowId = stateString(entry.windowId, `prepared window ${index} ID`); if (allWindowIds.has(windowId)) fail("state-corrupt", "duplicate window ID"); allWindowIds.add(windowId);
    preparedPartitions.set(pkey, windowId);
    stateString(entry.epochId, "prepared epoch ID", 256); enumValue(entry.reason, ["user-boundary", "main-admission", "subagent-admission"] as const, "prepared reason", true);
    enumValue(entry.mode, ["aggregate", "minimal-continuation"] as const, "prepared mode", true); timestamp(entry.createdAt, "prepared createdAt", true);
    if (entry.settled !== false) fail("state-corrupt", "prepared window is settled");
    const keys = array(entry.itemKeys, "prepared item keys");
    const own = new Set<string>(); for (const key of keys) { const id = stateString(key, "prepared item key"); if (!itemIds.has(id) || own.has(id)) fail("state-corrupt", "prepared item reference is invalid"); own.add(id); }
    const transactionIds = array(entry.leaseWakeTransactionIds, "prepared lease transactions");
    const ownTransactions = new Set<string>(); for (const transaction of transactionIds) { const id = stateString(transaction, "prepared lease transaction"); if (ownTransactions.has(id)) fail("state-corrupt", "duplicate prepared lease transaction"); ownTransactions.add(id); }
    validateStateBatch(entry.batch, { batchId, sessionScopeId, epochId: String(entry.epochId), reason: String(entry.reason), mode: String(entry.mode) }, fenceObserved);
  }
  const windowPartitions = new Map<string, string>();
  for (const [partition, windowId] of [...openPartitions, ...preparedPartitions]) windowPartitions.set(windowId, partition);
  for (const raw of items) {
    const item = raw as BrokerItemSnapshotV1;
    const expectedPartition = windowPartitions.get(item.windowId);
    if (!expectedPartition) fail("state-corrupt", "broker item references an unknown window");
    if (expectedPartition !== partitionKey(item.target, item.lane)) fail("state-corrupt", "broker item target/lane does not match its window");
  }
  validateOverflows(state.overflows, openPartitions, preparedPartitions, fenceObserved);
  const processOwners = validateProcessOwners(state.processOwners);
  validateWatches(state.watches, processOwners);
  validateTerminalProcesses(state.terminalProcesses, processOwners);
  const leaseBindings = validateLeaseBindings(state.leaseWakeBindings, fenceObserved, sessionScopeId);
  const settledBatchOutcomes = validateSettledBatches(state.settledBatches, preparedIds);
  const preparedById = new Map((state.prepared as PreparedWindowSnapshotV1[]).map((entry) => [entry.batchId, entry]));
  const standaloneBindings = validateStandaloneWakeBindings(state.standaloneWakeBindings, preparedById, settledBatchOutcomes);
  validateSettledStandaloneWakes(state.settledStandaloneWakes, standaloneBindings);
  validateRetirements(state.pendingRetirements, processOwners, leaseBindings, standaloneBindings);
  const retiringLeaseIds = new Set((state.pendingRetirements as RetirementPlanV1[]).flatMap((plan) => plan.leaseWakeTransactionIds));
  validateTuiDeliveries(state.tuiDeliveries, sessionScopeId);
  for (const binding of leaseBindings.values()) {
    if (retiringLeaseIds.has(binding.transactionId)) continue;
    if (binding.artifact.state === "pending" && !binding.artifact.entry) {
      fail("state-corrupt", "pending lease artifact has no immutable receipt entry");
    }
  }
  validateProcessScopedOwnership(state, processOwners, leaseBindings);
  const overflowEntries = state.overflows as TargetOverflowSnapshotV1[];
  for (const raw of prepared) {
    const entry = raw as PreparedWindowSnapshotV1;
    const expectedItemIds = (state.items as BrokerItemSnapshotV1[])
      .filter((item) => item.windowId === entry.windowId)
      .map((item) => itemId(item.windowId, item.key))
      .sort();
    if (JSON.stringify([...entry.itemKeys].sort()) !== JSON.stringify(expectedItemIds)) fail("state-corrupt", "prepared item set does not match its window");
    const preparedOverflow = overflowEntries.find((value) => targetKey(value.target) === targetKey(entry.target))?.prepared.find((summary) => summary.lane === entry.lane);
    if (entry.mode === "aggregate") {
      const itemsForWindow = itemsForPreparedWindow(state.items as BrokerItemSnapshotV1[], entry);
      const rebuilt = buildAggregateBatch({ target: entry.target, lane: entry.lane, batchId: entry.batchId, epochId: entry.epochId, reason: entry.reason, createdAt: entry.createdAt, mode: entry.mode }, sessionScopeId, entry.mode, itemsForWindow.sort(itemOrder), preparedOverflow, limits);
      if (canonicalBatchJson(rebuilt) !== canonicalBatchJson(entry.batch)) fail("state-corrupt", "prepared batch does not match its source window");
    }
    if (entry.mode === "minimal-continuation") {
      if (entry.leaseWakeTransactionIds.length < 1 || entry.leaseWakeTransactionIds.length > 50
        || entry.batch.items.length !== entry.leaseWakeTransactionIds.length) {
        fail("state-corrupt", "minimal continuation transaction and item counts are inconsistent");
      }
      const bindings = entry.leaseWakeTransactionIds.map((id) => leaseBindings.get(id));
      if (bindings.some((binding) => !binding)) fail("state-corrupt", "minimal continuation lease transaction is missing");
      const frozen = bindings as LeaseWakeBindingSnapshotV1[];
      const ordered = [...frozen].sort((a, b) => a.hostIncarnationId.localeCompare(b.hostIncarnationId) || a.notificationSequence - b.notificationSequence || a.transactionId.localeCompare(b.transactionId));
      if (JSON.stringify(ordered.map((binding) => binding.transactionId)) !== JSON.stringify(entry.leaseWakeTransactionIds)) fail("state-corrupt", "minimal continuation transactions are not canonically ordered");
      for (let index = 0; index < ordered.length; index++) {
        try { validateMinimalContinuationItem(entry.batch.items[index]!, ordered[index]!); }
        catch { fail("state-corrupt", "minimal continuation batch is invalid"); }
      }
      try { formatProcessNotificationBatchV1(entry.batch, { maxBytes: limits.batchBytes, maxExcerptBytes: 0 }); }
      catch { fail("state-corrupt", "minimal continuation batch exceeds its byte budget"); }
    }
    if (entry.mode === "aggregate") {
      const expectedLeaseIds = [...new Set([
        ...itemsForPreparedWindow(state.items as BrokerItemSnapshotV1[], entry).flatMap((item) => item.leaseWakeTransactionIds),
        ...(preparedOverflow?.leaseWakeTransactionIds ?? []),
      ])].sort();
      if (JSON.stringify([...entry.leaseWakeTransactionIds].sort()) !== JSON.stringify(expectedLeaseIds)) fail("state-corrupt", "prepared lease transaction set is inconsistent");
    }
    for (const transactionId of entry.leaseWakeTransactionIds) {
      const binding = leaseBindings.get(transactionId);
      if (!binding || targetKey(binding.target) !== targetKey(entry.target)) fail("state-corrupt", "prepared lease transaction reference is invalid");
      if (entry.mode === "minimal-continuation" && !entry.batch.items.some((item) => item.hostIncarnationId === binding.hostIncarnationId
        && binding.notificationSequence >= item.firstNotificationSequence
        && binding.notificationSequence <= item.lastNotificationSequence)) {
        fail("state-corrupt", "minimal continuation batch does not cover its lease transaction");
      }
    }
  }
  for (const overflow of overflowEntries) for (const summary of [...overflow.prepared, ...overflow.open]) {
    for (const transactionId of summary.leaseWakeTransactionIds) {
      const binding = leaseBindings.get(transactionId);
      const covered = binding && summary.sourceRanges.some((range) => range.hostIncarnationId === binding.hostIncarnationId
        && binding.notificationSequence >= range.firstNotificationSequence
        && binding.notificationSequence <= range.lastNotificationSequence);
      if (!binding || targetKey(binding.target) !== targetKey(overflow.target) || !covered) fail("state-corrupt", "overflow lease transaction reference is invalid");
    }
  }
  for (const raw of items) {
    const item = raw as BrokerItemSnapshotV1;
    for (const transactionId of item.leaseWakeTransactionIds) {
      const binding = leaseBindings.get(transactionId);
      if (!binding || binding.hostIncarnationId !== item.hostIncarnationId || binding.notificationSequence < item.firstNotificationSequence || binding.notificationSequence > item.lastNotificationSequence || targetKey(binding.target) !== targetKey(item.target)) {
        fail("state-corrupt", "broker item lease transaction reference is invalid");
      }
    }
  }
  const unresolved = new Map<string, number[]>();
  const addUnresolved = (incarnation: string, sequence: number): void => { const values = unresolved.get(incarnation) ?? []; values.push(sequence); unresolved.set(incarnation, values); };
  for (const item of state.items as BrokerItemSnapshotV1[]) addUnresolved(item.hostIncarnationId, item.firstNotificationSequence);
  for (const overflow of overflowEntries) for (const summary of [...overflow.prepared, ...overflow.open]) for (const range of summary.sourceRanges) addUnresolved(range.hostIncarnationId, range.firstNotificationSequence);
  for (const binding of leaseBindings.values()) addUnresolved(binding.hostIncarnationId, binding.notificationSequence);
  for (const [incarnation, observed] of fenceObserved) {
    const values = unresolved.get(incarnation) ?? [];
    const expectedCommitted = values.length === 0 ? observed : Math.max(0, Math.min(...values) - 1);
    if (fenceCommitted.get(incarnation) !== expectedCommitted) fail("state-corrupt", "committed source fence is inconsistent with unsettled state");
  }
  if (state.disposed && ((state.items as unknown[]).length > 0 || (state.prepared as unknown[]).length > 0 || (state.openWindows as unknown[]).length > 0 || (state.overflows as unknown[]).length > 0 || (state.processOwners as unknown[]).length > 0 || (state.watches as unknown[]).length > 0 || (state.terminalProcesses as unknown[]).length > 0 || (state.leaseWakeBindings as unknown[]).length > 0 || (state.standaloneWakeBindings as unknown[]).length > 0 || (state.tuiDeliveries as unknown[]).length > 0 || (state.pendingRetirements as unknown[]).length > 0)) fail("state-corrupt", "disposed broker retains active state");
  const counters = plainObject(state.counters, "broker counters");
  exact(counters, Object.keys(ZERO_COUNTERS), [], "broker counters"); for (const key of Object.keys(ZERO_COUNTERS)) stateInteger(counters[key], `counter ${key}`);
}

function validateStateBatch(
  value: unknown,
  expected: { batchId: string; sessionScopeId: string; epochId: string; reason: string; mode: string },
  fenceObserved: Map<string, number>,
): void {
  const batch = plainObject(value, "prepared batch");
  exact(batch, ["version", "batchId", "sessionScopeId", "epochId", "reason", "mode", "createdAt", "items"], ["overflow"], "prepared batch");
  if (batch.version !== 1 || batch.batchId !== expected.batchId || batch.sessionScopeId !== expected.sessionScopeId
    || batch.epochId !== expected.epochId || batch.reason !== expected.reason || batch.mode !== expected.mode) {
    fail("state-corrupt", "prepared batch identity does not match its window");
  }
  timestamp(batch.createdAt, "prepared batch createdAt", true);
  const items = array(batch.items, "prepared batch items");
  if (batch.mode === "minimal-continuation" && (items.length < 1 || items.length > 50)) fail("state-corrupt", "minimal continuation batch must contain between one and fifty items");
  for (const [index, item] of items.entries()) validateStateBatchItem(item, index, fenceObserved);
  if (batch.overflow !== undefined) {
    const overflow = plainObject(batch.overflow, "prepared batch overflow");
    exact(overflow, ["omittedItems", "byKind"], [], "prepared batch overflow");
    stateInteger(overflow.omittedItems, "prepared batch omitted items", 1);
    const byKind = plainObject(overflow.byKind, "prepared batch overflow kinds");
    for (const [kind, count] of Object.entries(byKind)) {
      enumValue(kind, ["terminal", "watch-match", "watch-suppressed", "matcher-error", "operational"] as const, "prepared batch overflow kind", true);
      stateInteger(count, "prepared batch overflow count", 1);
    }
  }
}

function validateStateBatchItem(value: unknown, index: number, fenceObserved: Map<string, number>): void {
  const label = `prepared batch item ${index}`;
  const item = plainObject(value, label);
  exact(item, ["kind", "count", "firstFactId", "lastFactId", "hostIncarnationId", "firstNotificationSequence", "lastNotificationSequence", "firstObservedAt", "lastObservedAt"], ["processId", "processName", "stableCode", "watchKey", "watchGeneration", "matchedCount", "suppressedCount", "terminal", "excerptRef", "latestExcerpt"], label);
  enumValue(item.kind, ["terminal", "watch-match", "watch-suppressed", "matcher-error", "operational"] as const, `${label}.kind`, true);
  stateInteger(item.count, `${label}.count`, 1); stateString(item.firstFactId, `${label}.firstFactId`, 1024); stateString(item.lastFactId, `${label}.lastFactId`, 1024);
  const incarnation = stateString(item.hostIncarnationId, `${label}.hostIncarnationId`, 256); const observed = fenceObserved.get(incarnation); if (observed === undefined) fail("state-corrupt", "prepared batch item has no source fence");
  const first = stateInteger(item.firstNotificationSequence, `${label}.firstSequence`, 1);
  const last = stateInteger(item.lastNotificationSequence, `${label}.lastSequence`, first); if (last > observed) fail("state-corrupt", "prepared batch item sequence exceeds source fence");
  const firstObservedAt = timestamp(item.firstObservedAt, `${label}.firstObservedAt`, true); const lastObservedAt = timestamp(item.lastObservedAt, `${label}.lastObservedAt`, true); if (Date.parse(firstObservedAt) > Date.parse(lastObservedAt)) fail("state-corrupt", `${label} observed range is invalid`);
  if (item.processId !== undefined) stateString(item.processId, `${label}.processId`, 256);
  if (item.processName !== undefined) stateString(item.processName, `${label}.processName`, 256);
  if (item.stableCode !== undefined) stateString(item.stableCode, `${label}.stableCode`, 128);
  if (item.watchKey !== undefined) stateString(item.watchKey, `${label}.watchKey`, 128);
  if (item.watchGeneration !== undefined) stateInteger(item.watchGeneration, `${label}.watchGeneration`, 1);
  const count = stateInteger(item.count, `${label}.count`, 1);
  const matched = item.matchedCount === undefined ? undefined : stateInteger(item.matchedCount, `${label}.matchedCount`);
  const suppressed = item.suppressedCount === undefined ? undefined : stateInteger(item.suppressedCount, `${label}.suppressedCount`);
  const kind = item.kind as NotificationKindV1;
  if ((item.processId === undefined) !== (item.processName === undefined) || (kind !== "operational" && item.processId === undefined)) fail("state-corrupt", `${label} process identity is invalid`);
  if (kind === "watch-match") { if (item.watchKey === undefined || item.watchGeneration === undefined || matched === undefined || suppressed === undefined || matched + suppressed !== count || item.terminal !== undefined) fail("state-corrupt", `${label} watch semantics are invalid`); }
  else if (item.watchKey !== undefined || item.watchGeneration !== undefined || matched !== undefined || suppressed !== undefined) fail("state-corrupt", `${label} has inapplicable watch fields`);
  if ((kind === "terminal") !== (item.terminal !== undefined)) fail("state-corrupt", `${label} terminal semantics are invalid`);
  if ((kind === "operational" || kind === "matcher-error") !== (item.stableCode !== undefined)) fail("state-corrupt", `${label} stableCode semantics are invalid`);
  if (item.terminal !== undefined) validateIdentity({ kind: "terminal", attention: "context", terminal: item.terminal, process: { id: String(item.processId), name: String(item.processName), kind: "process" } }, `${label}.terminal-wrapper`);
  if (item.excerptRef !== undefined) validateExcerptRef(item.excerptRef, `${label}.excerptRef`);
  if (item.latestExcerpt !== undefined) {
    const excerpt = plainObject(item.latestExcerpt, `${label}.latestExcerpt`); exact(excerpt, ["stream", "text", "truncated"], [], `${label}.latestExcerpt`);
    enumValue(excerpt.stream, ["stdout", "stderr"] as const, `${label}.latestExcerpt.stream`, true); if (typeof excerpt.text !== "string") fail("state-corrupt", `${label}.latestExcerpt.text is invalid`); bool(excerpt.truncated, `${label}.latestExcerpt.truncated`);
  }
}

function validateStateItem(value: unknown, index: number, identities: Set<string>, fenceObserved: Map<string, number>): void {
  const label = `broker item ${index}`; const item = plainObject(value, label);
  exact(item, ["key", "windowId", "target", "lane", "firstFactId", "lastFactId", "hostIncarnationId", "firstNotificationSequence", "lastNotificationSequence", "firstObservedAt", "lastObservedAt", "count", "identity", "leaseWakeTransactionIds"], ["matchedCount", "suppressedCount", "latestExcerptRef"], label);
  const key = itemId(stateString(item.windowId, `${label} window`, 256), stateString(item.key, `${label} key`, 4096)); if (identities.has(key)) fail("state-corrupt", "duplicate broker item"); identities.add(key);
  validateStateTarget(item.target, `${label} target`); enumValue(item.lane, ["context", "turn"] as const, `${label} lane`, true);
  stateString(item.firstFactId, `${label} firstFactId`, 1024); stateString(item.lastFactId, `${label} lastFactId`, 1024);
  const incarnation = stateString(item.hostIncarnationId, `${label} incarnation`, 256); const observed = fenceObserved.get(incarnation); if (observed === undefined) fail("state-corrupt", "broker item has no source fence");
  const first = stateInteger(item.firstNotificationSequence, `${label} first sequence`, 1); const last = stateInteger(item.lastNotificationSequence, `${label} last sequence`, first);
  if (last > observed) fail("state-corrupt", "broker item sequence exceeds source fence");
  const firstObservedAt = timestamp(item.firstObservedAt, `${label} first observed`, true); const lastObservedAt = timestamp(item.lastObservedAt, `${label} last observed`, true); if (Date.parse(firstObservedAt) > Date.parse(lastObservedAt)) fail("state-corrupt", `${label} observed range is invalid`); const count = stateInteger(item.count, `${label} count`, 1);
  const matched = item.matchedCount === undefined ? undefined : stateInteger(item.matchedCount, `${label} matched count`); const suppressed = item.suppressedCount === undefined ? undefined : stateInteger(item.suppressedCount, `${label} suppressed count`);
  validateIdentity(item.identity, `${label} identity`); const identity = item.identity as BrokerItemSnapshotV1["identity"];
  if (identity.kind === "watch-match") { if (matched === undefined || suppressed === undefined || matched + suppressed !== count) fail("state-corrupt", `${label} watch counts are inconsistent`); }
  else if (matched !== undefined || suppressed !== undefined) fail("state-corrupt", `${label} has inapplicable watch counts`);
  if (item.latestExcerptRef !== undefined) { const excerptRef = item.latestExcerptRef as NotificationExcerptRefV1; validateExcerptRef(excerptRef, `${label} excerpt`); if (!identity.process || excerptRef.processId !== identity.process.id) fail("state-corrupt", `${label} excerpt process identity is invalid`); }
  const transactions = array(item.leaseWakeTransactionIds, `${label} lease transactions`); const seen = new Set<string>();
  for (const transaction of transactions) { const id = stateString(transaction, "item lease transaction"); if (seen.has(id)) fail("state-corrupt", "duplicate item lease transaction"); seen.add(id); }
}
function validateIdentity(value: unknown, label: string): void {
  const identity = plainObject(value, label); exact(identity, ["kind", "attention"], ["process", "stableCode", "correlationId", "watch", "terminal"], label);
  const kind = enumValue(identity.kind, ["terminal", "watch-match", "matcher-error", "operational"] as const, `${label}.kind`, true);
  enumValue(identity.attention, ["turn", "context", "ignore"] as const, `${label}.attention`, true);
  if (identity.process !== undefined) { const process = plainObject(identity.process, `${label}.process`); exact(process, ["id", "name", "kind"], [], `${label}.process`); stateString(process.id, "process ID", 256); stateString(process.name, "process name", 256); enumValue(process.kind, ["process", "monitor", "service"] as const, "process kind", true); }
  if (kind !== "operational" && identity.process === undefined) fail("state-corrupt", `${label} requires process identity`);
  if (identity.stableCode !== undefined) stateString(identity.stableCode, "stable code", 128); if (identity.correlationId !== undefined) stateString(identity.correlationId, "correlation ID", 256);
  if ((kind === "operational" || kind === "matcher-error") !== (identity.stableCode !== undefined)) fail("state-corrupt", `${label} stableCode semantics are invalid`);
  if (identity.watch !== undefined) { const watch = plainObject(identity.watch, `${label}.watch`); exact(watch, ["key", "generation", "repeat", "firstSequence", "lastSequence"], [], `${label}.watch`); stateString(watch.key, "watch key", 128); stateInteger(watch.generation, "watch generation", 1); bool(watch.repeat, "watch repeat"); const first = stateInteger(watch.firstSequence, "watch first sequence", 1); stateInteger(watch.lastSequence, "watch last sequence", first); }
  if ((kind === "watch-match" || kind === "matcher-error") !== (identity.watch !== undefined)) fail("state-corrupt", `${label} watch semantics are invalid`);
  if ((kind === "terminal") !== (identity.terminal !== undefined)) fail("state-corrupt", `${label} terminal semantics are invalid`);
  if (identity.terminal !== undefined) {
    try { validateInputTerminal(identity.terminal as NonNullable<NotificationFactV1["terminal"]>); }
    catch { fail("state-corrupt", `${label}.terminal is invalid`); }
  }
}
function validateExcerptRef(value: unknown, label: string): void { const ref = plainObject(value, label); exact(ref, ["processId", "stream", "firstSequence", "lastSequence", "truncated"], [], label); stateString(ref.processId, `${label}.processId`, 256); enumValue(ref.stream, ["stdout", "stderr"] as const, `${label}.stream`, true); const first = stateInteger(ref.firstSequence, `${label}.firstSequence`, 1); stateInteger(ref.lastSequence, `${label}.lastSequence`, first); bool(ref.truncated, `${label}.truncated`); }
function validateOverflows(value: unknown, open: Map<string, string>, prepared: Map<string, string>, fenceObserved: Map<string, number>): void {
  const entries = array(value, "overflows"); const targets = new Set<string>();
  for (const [index, raw] of entries.entries()) { const entry = plainObject(raw, `overflow ${index}`); exact(entry, ["target", "prepared", "open"], [], `overflow ${index}`); const target = validateStateTarget(entry.target, `overflow ${index} target`); const tkey = targetKey(target); if (targets.has(tkey)) fail("state-corrupt", "duplicate target overflow"); targets.add(tkey);
    for (const [group, partitions] of [["prepared", prepared], ["open", open]] as const) { const summaries = array(entry[group], `overflow ${index} ${group}`); const lanes = new Set<string>(); for (const summary of summaries) { const lane = validateOverflowSummary(summary, `overflow ${index} ${group}`, fenceObserved); if (lanes.has(lane) || !partitions.has(partitionKey(target, lane))) fail("state-corrupt", "overflow lane reference is invalid"); lanes.add(lane); } }
  }
}
function validateOverflowSummary(value: unknown, label: string, fenceObserved: Map<string, number>): NotificationLaneV1 {
  const summary = plainObject(value, label); exact(summary, ["lane", "omittedItems", "byKind", "sourceRanges", "leaseWakeTransactionIds"], [], label); const lane = enumValue(summary.lane, ["context", "turn"] as const, `${label}.lane`, true); const omitted = stateInteger(summary.omittedItems, `${label}.omittedItems`, 1);
  const byKind = plainObject(summary.byKind, `${label}.byKind`); let byKindTotal = 0; for (const [kind, count] of Object.entries(byKind)) { enumValue(kind, ["terminal", "watch-match", "watch-suppressed", "matcher-error", "operational"] as const, `${label} kind`, true); byKindTotal += stateInteger(count, `${label} kind count`, 1); }
  if (byKindTotal !== omitted) fail("state-corrupt", "overflow counts are inconsistent");
  const ranges = array(summary.sourceRanges, `${label}.sourceRanges`); const byIncarnation = new Map<string, Array<{ first: number; last: number }>>(); for (const raw of ranges) { const range = plainObject(raw, `${label} range`); exact(range, ["hostIncarnationId", "firstNotificationSequence", "lastNotificationSequence"], [], `${label} range`); const id = stateString(range.hostIncarnationId, `${label} range incarnation`); const observed = fenceObserved.get(id); if (observed === undefined) fail("state-corrupt", "overflow source range is invalid"); const first = stateInteger(range.firstNotificationSequence, `${label} range first`, 1); const last = stateInteger(range.lastNotificationSequence, `${label} range last`, first); if (last > observed) fail("state-corrupt", "overflow source range exceeds source fence"); const prior = byIncarnation.get(id) ?? []; if (prior.some((entry) => !(last < entry.first || first > entry.last))) fail("state-corrupt", "overflow source ranges overlap"); prior.push({ first, last }); byIncarnation.set(id, prior); }
  const leaseIds = array(summary.leaseWakeTransactionIds, `${label}.leaseWakeTransactionIds`); const seenLeases = new Set<string>(); for (const raw of leaseIds) { const id = stateString(raw, `${label} lease transaction`); if (seenLeases.has(id)) fail("state-corrupt", "overflow lease transaction is duplicated"); seenLeases.add(id); }
  return lane;
}
function validateProcessOwners(value: unknown): Map<string, NotificationTargetV1> {
  const owners = new Map<string, NotificationTargetV1>();
  for (const [index, raw] of array(value, "process owners").entries()) {
    const item = plainObject(raw, `process owner ${index}`);
    exact(item, ["processId", "target"], [], `process owner ${index}`);
    const processId = stateString(item.processId, "process owner ID", 256);
    if (owners.has(processId)) fail("state-corrupt", "duplicate process owner");
    owners.set(processId, validateStateTarget(item.target, `process owner ${index} target`));
  }
  return owners;
}
function validateWatches(value: unknown, owners: Map<string, NotificationTargetV1>): void { const watches = array(value, "watches"); const seen = new Set<string>(); for (const [index, raw] of watches.entries()) { const item = plainObject(raw, `watch ${index}`); exact(item, ["processId", "key", "generation", "matchedCount", "suppressedCount", "firstSequence", "lastSequence", "lastObservedAt"], [], `watch ${index}`); const processId = stateString(item.processId, "watch process ID", 256); if (!owners.has(processId)) fail("state-corrupt", "watch snapshot has no process owner"); const key = stateString(item.key, "watch key", 128); const generation = stateInteger(item.generation, "watch generation", 1); const identity = watchSnapshotKey(processId, key, generation); if (seen.has(identity)) fail("state-corrupt", "duplicate watch snapshot"); seen.add(identity); stateInteger(item.matchedCount, "watch matched count"); stateInteger(item.suppressedCount, "watch suppressed count"); const first = stateInteger(item.firstSequence, "watch first sequence", 1); stateInteger(item.lastSequence, "watch last sequence", first); timestamp(item.lastObservedAt, "watch observedAt", true); } }
function validateTerminalProcesses(value: unknown, owners: Map<string, NotificationTargetV1>): void { const entries = array(value, "terminal processes"); const seen = new Set<string>(); for (const raw of entries) { const item = plainObject(raw, "terminal process"); exact(item, ["processId", "factId"], [], "terminal process"); const id = stateString(item.processId, "terminal process ID", 256); if (!owners.has(id)) fail("state-corrupt", "terminal process has no owner"); if (seen.has(id)) fail("state-corrupt", "duplicate terminal process"); seen.add(id); stateString(item.factId, "terminal fact ID", 1024); } }
function validateLeaseBindings(value: unknown, fenceObserved: Map<string, number>, sessionScopeId: string): Map<string, LeaseWakeBindingSnapshotV1> {
  const entries = array(value, "lease wake bindings"); const result = new Map<string, LeaseWakeBindingSnapshotV1>();
  for (const raw of entries) {
    const item = plainObject(raw, "lease wake binding"); exact(item, ["transactionId", "factId", "target", "lane", "hostIncarnationId", "notificationSequence", "artifact", "minimalItem"], [], "lease wake binding");
    const id = stateString(item.transactionId, "lease transaction ID", 256); if (result.has(id)) fail("state-corrupt", "duplicate lease wake binding");
    const factId = stateString(item.factId, "lease fact ID", 1024); const target = validateStateTarget(item.target, "lease target");
    const lane = enumValue(item.lane, ["context", "turn", "ignore"] as const, "lease source lane", true);
    const incarnation = stateString(item.hostIncarnationId, "lease incarnation", 256); const observed = fenceObserved.get(incarnation); if (observed === undefined) fail("state-corrupt", "lease binding has no source fence");
    const notificationSequence = stateInteger(item.notificationSequence, "lease sequence", 1); if (notificationSequence > observed) fail("state-corrupt", "lease binding sequence exceeds source fence");
    const bindingBase = { transactionId: id, factId, target, lane, hostIncarnationId: incarnation, notificationSequence, minimalItem: item.minimalItem as ProcessNotificationBatchItemV1 };
    const artifact = validateLeaseArtifact(item.artifact, true, sessionScopeId, bindingBase);
    const binding: LeaseWakeBindingSnapshotV1 = { ...bindingBase, artifact };
    try { validateMinimalContinuationItem(binding.minimalItem, binding); } catch { fail("state-corrupt", "lease minimal item is invalid"); }
    result.set(id, binding);
  }
  return result;
}
function validateSettledBatches(value: unknown, preparedIds: Set<string>): Map<string, SettledBatchSnapshotV1["outcome"]> {
  const entries = array(value, "settled batches"); if (entries.length > SETTLED_BATCH_LIMIT) fail("state-corrupt", "settled batch ledger is too large");
  const result = new Map<string, SettledBatchSnapshotV1["outcome"]>();
  for (const [index, raw] of entries.entries()) { const entry = plainObject(raw, `settled batch ${index}`); exact(entry, ["batchId", "outcome"], [], `settled batch ${index}`); const id = stateString(entry.batchId, "settled batch ID", 256); if (result.has(id) || preparedIds.has(id)) fail("state-corrupt", "settled batch identity is duplicated"); result.set(id, enumValue(entry.outcome, ["committed", "rolled-back"] as const, "settled batch outcome", true)); }
  return result;
}
function validateStandaloneWakeBindings(value: unknown, preparedById: Map<string, PreparedWindowSnapshotV1>, settledBatches: Map<string, SettledBatchSnapshotV1["outcome"]>): Map<string, StandaloneWakeBindingSnapshotV1> {
  const result = new Map<string, StandaloneWakeBindingSnapshotV1>();
  for (const [index, raw] of array(value, "standalone wake bindings").entries()) {
    const item = plainObject(raw, `standalone wake ${index}`); exact(item, ["transactionId", "target", "lane", "phase", "claimed"], ["batchId"], `standalone wake ${index}`);
    const transactionId = stateString(item.transactionId, "standalone transaction ID", 256); if (result.has(transactionId)) fail("state-corrupt", "duplicate standalone wake binding");
    const target = validateStateTarget(item.target, "standalone target"); if (item.lane !== "turn") fail("state-corrupt", "standalone wake lane is invalid"); bool(item.claimed, "standalone claimed");
    const phase = enumValue(item.phase, ["unbound", "batch-prepared", "batch-committed"] as const, "standalone wake phase", true);
    const batchId = item.batchId === undefined ? undefined : stateString(item.batchId, "standalone batch ID", 256);
    if (phase === "unbound" && batchId !== undefined) fail("state-corrupt", "unbound standalone wake retains batch identity");
    if (phase === "batch-prepared") {
      const prepared = batchId && preparedById.get(batchId);
      if (!prepared || prepared.lane !== "turn" || !sameTarget(prepared.target, target)) fail("state-corrupt", "prepared standalone wake references invalid batch");
    }
    if (phase === "batch-committed" && (!batchId || settledBatches.get(batchId) !== "committed")) fail("state-corrupt", "committed standalone wake references invalid batch");
    result.set(transactionId, { transactionId, target, lane: "turn", phase, ...(batchId ? { batchId } : {}), claimed: item.claimed as boolean });
  }
  return result;
}
function validateSettledStandaloneWakes(value: unknown, open: Map<string, StandaloneWakeBindingSnapshotV1>): void {
  const seen = new Set<string>(); const entries = array(value, "settled standalone wakes"); if (entries.length > SETTLED_STANDALONE_WAKE_LIMIT) fail("state-corrupt", "settled standalone wake ledger is too large");
  for (const raw of entries) { const item = plainObject(raw, "settled standalone wake"); exact(item, ["transactionId", "outcome"], [], "settled standalone wake"); const id = stateString(item.transactionId, "settled standalone transaction ID", 256); if (seen.has(id) || open.has(id)) fail("state-corrupt", "standalone transaction identity is duplicated"); seen.add(id); enumValue(item.outcome, ["delivered", "skipped", "aborted"] as const, "standalone wake outcome", true); }
}
function validateTuiIdentity(value: unknown, label: string): TuiDeliveryIdentityV1 {
  const identity = plainObject(value, label);
  const kind = enumValue(identity.kind, ["unique", "watch", "matcher", "operational"] as const, `${label}.kind`, true);
  if (kind === "unique") {
    exact(identity, ["kind", "eventKind", "hostIncarnationId", "processId", "factId"], [], label);
    return { kind, eventKind: enumValue(identity.eventKind, ["terminal", "watch-match"] as const, `${label}.eventKind`, true), hostIncarnationId: stateString(identity.hostIncarnationId, `${label}.hostIncarnationId`, 256), processId: stateString(identity.processId, `${label}.processId`, 256), factId: stateString(identity.factId, `${label}.factId`, 1024) };
  }
  if (kind === "watch") {
    exact(identity, ["kind", "hostIncarnationId", "processId", "watchKey", "watchGeneration"], [], label);
    return { kind, hostIncarnationId: stateString(identity.hostIncarnationId, `${label}.hostIncarnationId`, 256), processId: stateString(identity.processId, `${label}.processId`, 256), watchKey: stateString(identity.watchKey, `${label}.watchKey`, 128), watchGeneration: stateInteger(identity.watchGeneration, `${label}.watchGeneration`, 1) };
  }
  if (kind === "matcher") {
    exact(identity, ["kind", "hostIncarnationId", "processId", "watchKey", "watchGeneration", "stableCode"], [], label);
    return { kind, hostIncarnationId: stateString(identity.hostIncarnationId, `${label}.hostIncarnationId`, 256), processId: stateString(identity.processId, `${label}.processId`, 256), watchKey: stateString(identity.watchKey, `${label}.watchKey`, 128), watchGeneration: stateInteger(identity.watchGeneration, `${label}.watchGeneration`, 1), stableCode: stateString(identity.stableCode, `${label}.stableCode`, 128) };
  }
  exact(identity, ["kind", "hostIncarnationId", "stableCode"], ["processId", "correlationId"], label);
  return { kind, hostIncarnationId: stateString(identity.hostIncarnationId, `${label}.hostIncarnationId`, 256), ...(identity.processId === undefined ? {} : { processId: stateString(identity.processId, `${label}.processId`, 256) }), stableCode: stateString(identity.stableCode, `${label}.stableCode`, 128), ...(identity.correlationId === undefined ? {} : { correlationId: stateString(identity.correlationId, `${label}.correlationId`, 256) }) };
}
function validateTuiDeliveries(value: unknown, sessionScopeId: string): Map<string, TuiDeliveryRecordSnapshotV1> {
  const ids = new Set<string>(); const result = new Map<string, TuiDeliveryRecordSnapshotV1>(); const entries = array(value, "TUI deliveries");
  for (const raw of entries) {
    const item = plainObject(raw, "TUI delivery"); exact(item, ["deliveryId", "identity", "target", "firstFactId", "lastFactId", "count", "state"], ["processId", "entry"], "TUI delivery");
    const target = validateStateTarget(item.target, "TUI target");
    const identity = validateTuiIdentity(item.identity, "TUI identity");
    const id = stateString(item.deliveryId, "TUI delivery ID", 80);
    if (id !== tuiDeliveryId(target, identity) || ids.has(id)) fail("state-corrupt", "TUI delivery identity is invalid");
    ids.add(id);
    const processId = item.processId === undefined ? undefined : stateString(item.processId, "TUI process ID", 256);
    const identityProcessId = "processId" in identity ? identity.processId : undefined;
    if (processId !== identityProcessId) fail("state-corrupt", "TUI process identity is inconsistent");
    const firstFactId = stateString(item.firstFactId, "TUI first fact", 1024); stateString(item.lastFactId, "TUI last fact", 1024); stateInteger(item.count, "TUI delivery count", 1);
    const state = enumValue(item.state, ["pending", "recorded"] as const, "TUI delivery state", true);
    if (state === "pending") {
      if (item.entry === undefined) fail("state-corrupt", "pending TUI delivery has no entry");
      const entry = validateTuiEntryEnvelope(item.entry, true);
      const data = JSON.parse(entry.dataJson) as Record<string, unknown>;
      const entryProcess = data.process && typeof data.process === "object" && !Array.isArray(data.process)
        ? (data.process as Record<string, unknown>).id
        : undefined;
      if (entryProcess !== processId) fail("state-corrupt", "pending TUI entry process identity is inconsistent");
      const expectedKind = identity.kind === "unique"
        ? identity.eventKind
        : identity.kind === "watch" ? "watch-match" : identity.kind === "matcher" ? "matcher-error" : "operational";
      if (expectedKind === undefined || data.kind !== expectedKind) fail("state-corrupt", "pending TUI entry kind is inconsistent");
    } else if (item.entry !== undefined) fail("state-corrupt", "recorded TUI tombstone retains entry");
    result.set(id, item as unknown as TuiDeliveryRecordSnapshotV1);
  }
  return result;
}
function validateProcessScopedOwnership(
  state: Record<string, unknown>,
  owners: Map<string, NotificationTargetV1>,
  leases: Map<string, LeaseWakeBindingSnapshotV1>,
): void {
  for (const item of state.items as BrokerItemSnapshotV1[]) {
    const processId = item.identity.process?.id;
    if (processId && !sameTarget(owners.get(processId) ?? fail("state-corrupt", "broker item has no process owner"), item.target)) fail("state-corrupt", "broker item process owner is inconsistent");
  }
  for (const delivery of state.tuiDeliveries as TuiDeliveryRecordSnapshotV1[]) {
    if (delivery.processId && !sameTarget(owners.get(delivery.processId) ?? fail("state-corrupt", "TUI delivery has no process owner"), delivery.target)) fail("state-corrupt", "TUI delivery process owner is inconsistent");
  }
  for (const binding of leases.values()) {
    const processId = binding.minimalItem.processId;
    if (!processId || !sameTarget(owners.get(processId) ?? fail("state-corrupt", "lease binding has no process owner"), binding.target)) fail("state-corrupt", "lease binding process owner is inconsistent");
  }
}
function validateRetirements(
  value: unknown,
  owners: Map<string, NotificationTargetV1>,
  leases: Map<string, LeaseWakeBindingSnapshotV1>,
  standalone: Map<string, StandaloneWakeBindingSnapshotV1>,
): void {
  const entries = array(value, "pending retirements"); const ids = new Set<string>(); let scopeSeen = false; const targets = new Set<string>();
  for (const raw of entries) {
    const item = plainObject(raw, "retirement plan"); exact(item, ["retirementId", "kind", "processIds", "leaseWakeTransactionIds", "standaloneWakeTransactionIds", "state"], ["target"], "retirement plan");
    const id = stateString(item.retirementId, "retirement ID", 256); if (ids.has(id)) fail("state-corrupt", "duplicate retirement ID"); ids.add(id);
    const kind = enumValue(item.kind, ["target", "scope"] as const, "retirement kind", true); if (item.state !== "pending") fail("state-corrupt", "retirement state is invalid");
    const target = item.target === undefined ? undefined : validateStateTarget(item.target, "retirement target");
    if ((kind === "target") !== (target !== undefined)) fail("state-corrupt", "retirement target is invalid");
    if (kind === "scope") { if (scopeSeen || targets.size > 0) fail("state-corrupt", "scope retirement conflicts with target retirement"); scopeSeen = true; }
    else { const key = targetKey(target!); if (scopeSeen || targets.has(key)) fail("state-corrupt", "duplicate retirement target"); targets.add(key); }
    const processIds = array(item.processIds, "retirement process IDs").map((rawId) => stateString(rawId, "retirement process ID", 256));
    const leaseIds = array(item.leaseWakeTransactionIds, "retirement lease IDs").map((rawId) => stateString(rawId, "retirement lease ID", 256));
    const standaloneIds = array(item.standaloneWakeTransactionIds, "retirement standalone IDs").map((rawId) => stateString(rawId, "retirement standalone ID", 256));
    if (new Set(processIds).size !== processIds.length || new Set(leaseIds).size !== leaseIds.length || new Set(standaloneIds).size !== standaloneIds.length) fail("state-corrupt", "retirement ownership identity is duplicated");
    const expectedProcesses = [...owners.entries()].filter(([, owner]) => !target || sameTarget(owner, target)).map(([processId]) => processId).sort();
    const expectedLeases = [...leases.values()].filter((binding) => !target || sameTarget(binding.target, target)).map((binding) => binding.transactionId).sort();
    const expectedStandalone = [...standalone.values()].filter((binding) => !target || sameTarget(binding.target, target)).map((binding) => binding.transactionId).sort();
    if (JSON.stringify([...processIds].sort()) !== JSON.stringify(expectedProcesses)
      || JSON.stringify([...leaseIds].sort()) !== JSON.stringify(expectedLeases)
      || JSON.stringify([...standaloneIds].sort()) !== JSON.stringify(expectedStandalone)) fail("state-corrupt", "retirement ownership set is incomplete");
  }
}

export function parseProcessNotificationBatchV1(value: unknown, sessionScopeId: string): ProcessNotificationBatchV1 {
  nonempty(sessionScopeId, "batch session scope", 512);
  const object = inputObject(value, "notification batch");
  exactInput(object, ["version", "batchId", "sessionScopeId", "epochId", "reason", "mode", "createdAt", "items"], ["overflow"], "notification batch");
  if (object.version !== 1) fail("invalid-fact", "notification batch version is invalid");
  const batchId = nonempty(object.batchId, "notification batch ID", 256);
  const actualScope = nonempty(object.sessionScopeId, "notification batch session scope", 512);
  if (actualScope !== sessionScopeId) fail("session-mismatch", "notification batch belongs to another session scope");
  const epochId = nonempty(object.epochId, "notification batch epoch ID", 256);
  const reason = enumValue(object.reason, ["user-boundary", "main-admission", "subagent-admission"] as const, "notification batch reason");
  const mode = enumValue(object.mode, ["aggregate", "minimal-continuation"] as const, "notification batch mode");
  const items = array(object.items, "notification batch items");
  const fences = new Map<string, number>();
  for (const [index, raw] of items.entries()) {
    const item = inputObject(raw, `notification batch item ${index}`);
    const incarnation = nonempty(item.hostIncarnationId, `notification batch item ${index}.hostIncarnationId`, 256);
    const last = integer(item.lastNotificationSequence, `notification batch item ${index}.lastNotificationSequence`, 1);
    fences.set(incarnation, Math.max(fences.get(incarnation) ?? 0, last));
  }
  validateStateBatch(object, { batchId, sessionScopeId, epochId, reason, mode }, fences);
  const batch = structuredClone(object) as unknown as ProcessNotificationBatchV1;
  try { formatProcessNotificationBatchV1(batch); }
  catch (error) { if (error instanceof NotificationFormattingErrorV1) fail("invalid-fact", error.message); throw error; }
  return deepFreeze(batch);
}

export function createNotificationBrokerV1(options: NotificationBrokerOptionsV1): NotificationBrokerV1 { return new NotificationBroker(options); }
export function restoreNotificationBrokerV1(state: NotificationBrokerStateV1, options: NotificationBrokerOptionsV1): NotificationBrokerV1 {
  const broker = new NotificationBroker(options);
  validateBrokerState(state, options.sessionScopeId, broker.limits);
  broker.loadState(structuredClone(state));
  if (canonicalNotificationStateJsonV1(state) !== canonicalNotificationStateJsonV1(broker.exportState())) fail("state-corrupt", "notification broker state is not canonical");
  broker.applyPressure(); broker.recomputeCommittedFences(); broker.assertCapacity(); return broker;
}
