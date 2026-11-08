import { createHash } from "node:crypto";
import { canonicalJson } from "../capabilities/canonical.js";
import { crc32cHex } from "./crc32.js";

export const MAX_JOURNAL_PAYLOAD_BYTES = 1_048_576;
export const MAX_TRANSACTION_BYTES = 67_108_864;
export const MAX_TRANSACTION_MUTATIONS = 8_192;
export const MAX_TRANSACTION_FRAMES = 65_536;
/**
 * 3 adds Main handled/handling_proof and local continuation_native observations.
 * 2 has Root-header-only puts; 1 has full Root puts. Older formats are replayed
 * once and checkpointed to 3 before writes, so an old reader cannot reset new facts.
 */
export const JOURNAL_FORMAT_VERSION = 3;
export const ROOT_HEADER_JOURNAL_FORMAT_VERSION = 2;
export const LEGACY_JOURNAL_FORMAT_VERSION = 1;
const HEADER_BYTES = 41;
const HEADER_PATTERN = /^PSAJ1 ([0-9a-f]{16}) ([0-9a-f]{8}) ([0-9a-f]{8})\n$/u;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TX_ID = /^txn_[A-Za-z0-9_-]{22}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

export type EntityTypeV1 =
  | "agent" | "task" | "mailbox" | "barrier" | "completion"
  | "inbox" | "outbox" | "owner-event" | "operation-receipt" | "wake-receipt"
  | "cleanup" | "tombstone" | "root";

export interface JournalAnchorV1 {
  readonly version: typeof JOURNAL_FORMAT_VERSION | typeof ROOT_HEADER_JOURNAL_FORMAT_VERSION | typeof LEGACY_JOURNAL_FORMAT_VERSION;
  readonly type: "journal-anchor";
  readonly checkpoint_generation: number;
  readonly checkpoint_revision: number;
  readonly checkpoint_state_sha256: string;
  readonly created_at: string;
}

export interface TransactionBeginV1 {
  readonly version: 1;
  readonly type: "tx-begin";
  readonly transaction_id: string;
  readonly base_revision: number;
  readonly revision: number;
  readonly operation: string;
  readonly created_at: string;
}

export interface TransactionPutV1 {
  readonly version: 1;
  readonly type: "put";
  readonly transaction_id: string;
  readonly entity_type: EntityTypeV1;
  readonly entity_id: string;
  readonly value: unknown;
}

export interface TransactionDeleteV1 {
  readonly version: 1;
  readonly type: "delete";
  readonly transaction_id: string;
  readonly entity_type: EntityTypeV1;
  readonly entity_id: string;
  readonly expected_record_revision: number;
}

export interface TransactionDeleteSubtreeV1 {
  readonly version: 1;
  readonly type: "delete-subtree";
  readonly transaction_id: string;
  readonly tombstone: unknown;
}

export interface TransactionCommitV1 {
  readonly version: 1;
  readonly type: "tx-commit";
  readonly transaction_id: string;
  readonly revision: number;
  readonly mutation_count: number;
  readonly transaction_sha256: string;
  readonly committed_at: string;
}

export type TransactionMutationV1 = TransactionPutV1 | TransactionDeleteV1 | TransactionDeleteSubtreeV1;
export type JournalPayloadV1 = JournalAnchorV1 | TransactionBeginV1 | TransactionMutationV1 | TransactionCommitV1;

export interface JournalFrameV1 {
  readonly sequence: number;
  readonly payloadBytes: Uint8Array;
  readonly payload: JournalPayloadV1;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface CommittedTransactionV1 {
  readonly begin: TransactionBeginV1;
  readonly mutations: readonly TransactionMutationV1[];
  readonly commit: TransactionCommitV1;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export type JournalScanResultV1 =
  | {
      readonly status: "valid";
      readonly anchor: JournalAnchorV1;
      readonly frames: readonly JournalFrameV1[];
      readonly committed: readonly CommittedTransactionV1[];
      readonly lastValidOffset: number;
      readonly lastCommittedOffset: number;
      readonly nextSequence: number;
      readonly nextRevision: number;
    }
  | {
      readonly status: "recoverable-tail";
      readonly anchor: JournalAnchorV1;
      readonly frames: readonly JournalFrameV1[];
      readonly committed: readonly CommittedTransactionV1[];
      readonly lastValidOffset: number;
      readonly lastCommittedOffset: number;
      readonly tailOffset: number;
      readonly tailBytes: Uint8Array;
      readonly reason: string;
      readonly nextSequence: number;
      readonly nextRevision: number;
    }
  | {
      readonly status: "corrupt";
      readonly reason: string;
      readonly offset: number;
    };

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !ISO_MILLIS.test(value) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`);
  return value;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unknown or missing keys`);
  return object;
}

function transactionId(value: unknown): string {
  if (typeof value !== "string" || !TX_ID.test(value)) throw new Error("transaction_id is invalid");
  return value;
}

const ENTITY_TYPES = new Set<EntityTypeV1>([
  "agent", "task", "mailbox", "barrier", "completion", "inbox", "outbox",
  "owner-event", "operation-receipt", "wake-receipt", "cleanup", "tombstone", "root",
]);

function parsePayload(value: unknown): JournalPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("journal payload must be an object");
  const type = (value as { type?: unknown }).type;
  if (type === "journal-anchor") {
    const object = exactObject(value, ["version", "type", "checkpoint_generation", "checkpoint_revision", "checkpoint_state_sha256", "created_at"], "journal anchor");
    if (object.version !== JOURNAL_FORMAT_VERSION && object.version !== ROOT_HEADER_JOURNAL_FORMAT_VERSION && object.version !== LEGACY_JOURNAL_FORMAT_VERSION) throw new Error(`journal format version ${String(object.version)} is not supported：这个 Main 的 Subagents store 由更新版本的 pi-subagents 写入。升级 pi-subagents 后再打开，不要删除 store 目录`);
    if (typeof object.checkpoint_state_sha256 !== "string" || !HEX64.test(object.checkpoint_state_sha256)) throw new Error("anchor state digest is invalid");
    return {
      version: object.version,
      type,
      checkpoint_generation: safeInteger(object.checkpoint_generation, "checkpoint_generation", 1),
      checkpoint_revision: safeInteger(object.checkpoint_revision, "checkpoint_revision"),
      checkpoint_state_sha256: object.checkpoint_state_sha256,
      created_at: timestamp(object.created_at, "created_at"),
    };
  }
  if (type === "tx-begin") {
    const object = exactObject(value, ["version", "type", "transaction_id", "base_revision", "revision", "operation", "created_at"], "transaction begin");
    if (object.version !== 1 || typeof object.operation !== "string" || object.operation.length < 1 || Buffer.byteLength(object.operation) > 256 || /[\r\n\u0000-\u001f\u007f-\u009f]/u.test(object.operation)) throw new Error("transaction begin is invalid");
    const base = safeInteger(object.base_revision, "base_revision");
    const revision = safeInteger(object.revision, "revision", 1);
    if (revision !== base + 1) throw new Error("transaction revision must equal base + 1");
    return { version: 1, type, transaction_id: transactionId(object.transaction_id), base_revision: base, revision, operation: object.operation, created_at: timestamp(object.created_at, "created_at") };
  }
  if (type === "put") {
    const object = exactObject(value, ["version", "type", "transaction_id", "entity_type", "entity_id", "value"], "put mutation");
    if (object.version !== 1 || typeof object.entity_type !== "string" || !ENTITY_TYPES.has(object.entity_type as EntityTypeV1) || typeof object.entity_id !== "string" || object.entity_id.length < 1 || Buffer.byteLength(object.entity_id) > 512) throw new Error("put mutation is invalid");
    canonicalJson(object.value);
    return { version: 1, type, transaction_id: transactionId(object.transaction_id), entity_type: object.entity_type as EntityTypeV1, entity_id: object.entity_id, value: object.value };
  }
  if (type === "delete") {
    const object = exactObject(value, ["version", "type", "transaction_id", "entity_type", "entity_id", "expected_record_revision"], "delete mutation");
    if (object.version !== 1 || typeof object.entity_type !== "string" || !ENTITY_TYPES.has(object.entity_type as EntityTypeV1) || typeof object.entity_id !== "string" || object.entity_id.length < 1 || Buffer.byteLength(object.entity_id) > 512) throw new Error("delete mutation is invalid");
    return { version: 1, type, transaction_id: transactionId(object.transaction_id), entity_type: object.entity_type as EntityTypeV1, entity_id: object.entity_id, expected_record_revision: safeInteger(object.expected_record_revision, "expected_record_revision", 1) };
  }
  if (type === "delete-subtree") {
    const object = exactObject(value, ["version", "type", "transaction_id", "tombstone"], "delete-subtree mutation");
    if (object.version !== 1) throw new Error("delete-subtree version is invalid");
    canonicalJson(object.tombstone);
    return { version: 1, type, transaction_id: transactionId(object.transaction_id), tombstone: object.tombstone };
  }
  if (type === "tx-commit") {
    const object = exactObject(value, ["version", "type", "transaction_id", "revision", "mutation_count", "transaction_sha256", "committed_at"], "transaction commit");
    if (object.version !== 1 || typeof object.transaction_sha256 !== "string" || !HEX64.test(object.transaction_sha256)) throw new Error("transaction commit is invalid");
    return {
      version: 1,
      type,
      transaction_id: transactionId(object.transaction_id),
      revision: safeInteger(object.revision, "revision", 1),
      mutation_count: safeInteger(object.mutation_count, "mutation_count"),
      transaction_sha256: object.transaction_sha256,
      committed_at: timestamp(object.committed_at, "committed_at"),
    };
  }
  throw new Error("unknown journal payload type");
}

function parseCanonicalPayload(bytes: Uint8Array): JournalPayloadV1 {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("journal payload is invalid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("journal payload is invalid JSON");
  }
  if (canonicalJson(raw) !== text) throw new Error("journal payload is not canonical JSON");
  return parsePayload(raw);
}

/** 一个 payload 编码后的字节数；commit 前用它预检单帧上限，不必等编码时抛错。 */
export function payloadByteLengthV1(payload: JournalPayloadV1): number {
  return Buffer.byteLength(canonicalJson(payload), "utf8");
}

export function encodePayloadV1(payload: JournalPayloadV1): Uint8Array {
  const parsed = parsePayload(payload);
  const bytes = Buffer.from(canonicalJson(parsed), "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_JOURNAL_PAYLOAD_BYTES) throw new Error("journal payload length is out of range");
  return bytes;
}

export function encodeFrameV1(sequence: number, payload: JournalPayloadV1 | Uint8Array): Uint8Array {
  safeInteger(sequence, "sequence", 1);
  const payloadBytes = payload instanceof Uint8Array ? Buffer.from(payload) : Buffer.from(encodePayloadV1(payload));
  if (payloadBytes.byteLength < 1 || payloadBytes.byteLength > MAX_JOURNAL_PAYLOAD_BYTES) throw new Error("journal payload length is out of range");
  parseCanonicalPayload(payloadBytes);
  const header = `PSAJ1 ${sequence.toString(16).padStart(16, "0")} ${payloadBytes.byteLength.toString(16).padStart(8, "0")} ${crc32cHex(payloadBytes)}\n`;
  if (Buffer.byteLength(header) !== HEADER_BYTES) throw new Error("journal header width invariant failed");
  return Buffer.concat([Buffer.from(header, "ascii"), payloadBytes, Buffer.from("\n")]);
}

export function transactionDigestV1(payloads: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  let total = 0;
  for (const payload of payloads) {
    if (payload.byteLength < 1 || payload.byteLength > MAX_JOURNAL_PAYLOAD_BYTES) throw new Error("transaction payload length is out of range");
    total += payload.byteLength;
    if (total > MAX_TRANSACTION_BYTES) throw new Error("transaction exceeds 64 MiB");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(payload.byteLength));
    hash.update(length);
    hash.update(payload);
  }
  return hash.digest("hex");
}

function hasCompleteFrameAfter(bytes: Uint8Array, from: number): boolean {
  const marker = Buffer.from("PSAJ1 ", "ascii");
  for (let offset = Math.max(from, 0); offset <= bytes.byteLength - HEADER_BYTES; offset++) {
    if (!Buffer.from(bytes.subarray(offset, offset + marker.length)).equals(marker)) continue;
    const headerText = Buffer.from(bytes.subarray(offset, offset + HEADER_BYTES)).toString("ascii");
    const match = HEADER_PATTERN.exec(headerText);
    if (!match) continue;
    const length = Number.parseInt(match[2]!, 16);
    const end = offset + HEADER_BYTES + length + 1;
    if (length >= 1 && length <= MAX_JOURNAL_PAYLOAD_BYTES && end <= bytes.byteLength && bytes[end - 1] === 0x0a) return true;
  }
  return false;
}

export function scanJournalV1(bytes: Uint8Array, manifestLastSequence: number, manifestRevision: number, expectedAnchor?: { checkpointGeneration: number; stateSha256: string }): JournalScanResultV1 {
  safeInteger(manifestLastSequence, "manifestLastSequence");
  safeInteger(manifestRevision, "manifestRevision");
  const frames: JournalFrameV1[] = [];
  const committed: CommittedTransactionV1[] = [];
  let offset = 0;
  let expectedSequence = manifestLastSequence + 1;
  let currentRevision = manifestRevision;
  let lastCommittedOffset = 0;
  let open: { begin: TransactionBeginV1; beginBytes: Uint8Array; mutations: TransactionMutationV1[]; payloads: Uint8Array[]; firstSequence: number; frames: number; bytes: number } | undefined;

  const fail = (reason: string, failureOffset: number, recoverableFinalTail = false): JournalScanResultV1 => {
    if (recoverableFinalTail && frames.length > 0 && !hasCompleteFrameAfter(bytes, failureOffset + 1)) {
      const anchor = frames[0]!.payload as JournalAnchorV1;
      return {
        status: "recoverable-tail",
        anchor,
        frames: Object.freeze([...frames]),
        committed: Object.freeze([...committed]),
        lastValidOffset: lastCommittedOffset,
        lastCommittedOffset,
        tailOffset: lastCommittedOffset,
        tailBytes: Buffer.from(bytes.subarray(lastCommittedOffset)),
        reason,
        nextSequence: committed.at(-1)?.lastSequence !== undefined
          ? committed.at(-1)!.lastSequence + 1
          : frames[0]!.sequence + 1,
        nextRevision: currentRevision + 1,
      };
    }
    return { status: "corrupt", reason, offset: failureOffset };
  };

  while (offset < bytes.byteLength) {
    const start = offset;
    if (bytes.byteLength - offset < HEADER_BYTES) return fail("truncated final frame header", start, true);
    const headerText = Buffer.from(bytes.subarray(offset, offset + HEADER_BYTES)).toString("ascii");
    const match = HEADER_PATTERN.exec(headerText);
    if (!match) return fail("invalid journal frame header", start);
    const sequence = Number.parseInt(match[1]!, 16);
    const length = Number.parseInt(match[2]!, 16);
    if (sequence !== expectedSequence) return fail("journal frame sequence gap", start);
    if (length < 1 || length > MAX_JOURNAL_PAYLOAD_BYTES) return fail("journal payload length is out of range", start);
    const payloadStart = offset + HEADER_BYTES;
    const end = payloadStart + length + 1;
    if (end > bytes.byteLength) return fail("truncated final frame payload", start, true);
    if (bytes[end - 1] !== 0x0a) return fail("journal frame trailing LF is missing", start, true);
    const payloadBytes = Buffer.from(bytes.subarray(payloadStart, payloadStart + length));
    if (crc32cHex(payloadBytes) !== match[3]) return fail("journal frame CRC-32C mismatch", start, true);
    let payload: JournalPayloadV1;
    try {
      payload = parseCanonicalPayload(payloadBytes);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), start);
    }
    const frame: JournalFrameV1 = { sequence, payloadBytes, payload, startOffset: start, endOffset: end };
    frames.push(frame);
    expectedSequence++;
    offset = end;

    if (frames.length === 1) {
      if (payload.type !== "journal-anchor") return { status: "corrupt", reason: "journal must start with an anchor", offset: start };
      if (payload.checkpoint_revision !== manifestRevision) return { status: "corrupt", reason: "anchor revision does not match checkpoint", offset: start };
      if (expectedAnchor && (payload.checkpoint_generation !== expectedAnchor.checkpointGeneration || payload.checkpoint_state_sha256 !== expectedAnchor.stateSha256)) return { status: "corrupt", reason: "anchor does not match checkpoint manifest", offset: start };
      lastCommittedOffset = end;
      continue;
    }
    if (payload.type === "journal-anchor") return { status: "corrupt", reason: "journal contains a second anchor", offset: start };
    if (payload.type === "tx-begin") {
      if (open) return { status: "corrupt", reason: "journal transaction interleaving is forbidden", offset: start };
      if (payload.base_revision !== currentRevision || payload.revision !== currentRevision + 1) return { status: "corrupt", reason: "transaction revision continuity failed", offset: start };
      open = { begin: payload, beginBytes: payloadBytes, mutations: [], payloads: [payloadBytes], firstSequence: sequence, frames: 1, bytes: payloadBytes.byteLength };
      continue;
    }
    if (!open) return { status: "corrupt", reason: "mutation or commit outside a transaction", offset: start };
    open.frames++;
    open.bytes += payloadBytes.byteLength;
    if (open.frames > MAX_TRANSACTION_FRAMES || open.bytes > MAX_TRANSACTION_BYTES) return { status: "corrupt", reason: "transaction bounds exceeded", offset: start };
    if (payload.type === "tx-commit") {
      if (payload.transaction_id !== open.begin.transaction_id || payload.revision !== open.begin.revision || payload.mutation_count !== open.mutations.length || payload.transaction_sha256 !== transactionDigestV1(open.payloads)) return { status: "corrupt", reason: "transaction commit validation failed", offset: start };
      committed.push(Object.freeze({ begin: open.begin, mutations: Object.freeze(open.mutations), commit: payload, firstSequence: open.firstSequence, lastSequence: sequence }));
      currentRevision = payload.revision;
      lastCommittedOffset = end;
      open = undefined;
      continue;
    }
    if (payload.transaction_id !== open.begin.transaction_id) return { status: "corrupt", reason: "transaction mutation id mismatch", offset: start };
    open.mutations.push(payload);
    open.payloads.push(payloadBytes);
    if (open.mutations.length > MAX_TRANSACTION_MUTATIONS) return { status: "corrupt", reason: "transaction mutation bound exceeded", offset: start };
  }
  const anchor = frames[0]?.payload;
  if (!anchor || anchor.type !== "journal-anchor") return { status: "corrupt", reason: "journal is empty or lacks an anchor", offset: 0 };
  if (open) {
    return {
      status: "recoverable-tail",
      anchor,
      frames: Object.freeze([...frames]),
      committed: Object.freeze([...committed]),
      lastValidOffset: offset,
      lastCommittedOffset,
      tailOffset: lastCommittedOffset,
      tailBytes: Buffer.from(bytes.subarray(lastCommittedOffset)),
      reason: "final transaction has no commit",
      nextSequence: committed.at(-1)?.lastSequence !== undefined
        ? committed.at(-1)!.lastSequence + 1
        : frames[0]!.sequence + 1,
      nextRevision: currentRevision + 1,
    };
  }
  return {
    status: "valid",
    anchor,
    frames: Object.freeze(frames),
    committed: Object.freeze(committed),
    lastValidOffset: offset,
    lastCommittedOffset,
    nextSequence: expectedSequence,
    nextRevision: currentRevision + 1,
  };
}
