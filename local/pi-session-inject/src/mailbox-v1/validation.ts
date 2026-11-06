import { MAILBOX_PENDING_SCHEMA_V1 } from "./schema.js";
import type { Mail, MailboxSnapshot, NativeEntryRef, PendingRecord, TerminalRecord } from "./types.js";

import { cloneJson, same, recordKey, invalid } from "./json.js";
export { cloneJson, same, recordKey, bodyKey, invalid } from "./json.js";
type Schema = {
  $ref?: string;
  const?: unknown;
  enum?: readonly unknown[];
  type?: string;
  anyOf?: readonly Schema[];
  oneOf?: readonly Schema[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
};
/** Small interpreter for the exact vocabulary used by our frozen schema. */
function validate(value: unknown, schema: Schema, path: string): void {
  if (schema.$ref) return validate(value, (MAILBOX_PENDING_SCHEMA_V1.$defs as Record<string, Schema>)[schema.$ref.slice(8)]!, path);
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const matches = branches.filter((branch) => {
      try {
        validate(value, branch, path);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (matches === 0 || (schema.oneOf && matches !== 1)) invalid(`${path}: invalid union`);
    return;
  }
  if ("const" in schema && !same(value, schema.const)) invalid(`${path}: invalid constant`);
  if (schema.enum && !schema.enum.some((item) => same(item, value))) invalid(`${path}: invalid enum`);
  if (!schema.type) return;
  if (schema.type === "null") {
    if (value !== null) invalid(`${path}: expected null`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0)) invalid(`${path}: invalid array`);
    value.forEach((item, index) => validate(item, schema.items!, `${path}[${index}]`));
    return;
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${path}: expected object`);
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) invalid(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(obj)) {
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
      if (property) validate(item, property, `${path}.${key}`);
      else if (schema.additionalProperties === false) invalid(`${path}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === "object") validate(item, schema.additionalProperties, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      invalid(`${path}: invalid number`);
    return;
  }
  if (typeof value !== schema.type) invalid(`${path}: expected ${schema.type}`);
  if (typeof value === "string" && value.length < (schema.minLength ?? 0)) invalid(`${path}: empty string`);
}
export function validateDefinition(value: unknown, definition: keyof typeof MAILBOX_PENDING_SCHEMA_V1.$defs): void {
  validate(value, MAILBOX_PENDING_SCHEMA_V1.$defs[definition] as Schema, definition);
}
export function frozenMail(value: Mail): Mail {
  const clone = cloneJson(value);
  validateDefinition(clone, "mail");
  return deepFreeze(clone);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function checkEntries(mail: Mail, entries: readonly NativeEntryRef[], complete = false): void {
  const indexes = new Set<number>(),
    ids = new Set<string>();
  for (const entry of entries) {
    if (entry.messageIndex >= mail.messages.length || indexes.has(entry.messageIndex) || ids.has(entry.entryId))
      invalid("duplicate/out-of-range native proof");
    indexes.add(entry.messageIndex);
    ids.add(entry.entryId);
  }
  if (complete && indexes.size !== mail.messages.length) invalid("incomplete recorded native proof");
}
function nativeEntryIds(entries: readonly NativeEntryRef[]): readonly string[] {
  return [...entries].sort((a, b) => a.messageIndex - b.messageIndex).map((entry) => entry.entryId);
}
function checkRecord(record: PendingRecord | TerminalRecord, sessionId: string): void {
  const mail = "mail" in record ? record.mail : record;
  const scope = { sessionId, anchorEntryId: mail.anchorEntryId };
  if ("nativeEntries" in record) checkEntries(mail, record.nativeEntries);
  if ("legacyImport" in record && record.legacyImport) {
    const { evidence, proof } = record.legacyImport;
    if (
      evidence.producer !== mail.producer ||
      evidence.key !== mail.key ||
      !same(evidence.scope, scope) ||
      evidence.assistantEntryId !== proof.assistantEntryId ||
      !record.recorded ||
      !same(evidence.nativeEntryIds, nativeEntryIds(record.nativeEntries))
    )
      invalid("legacy import identity/proof mismatch");
    checkEntries(mail, record.nativeEntries, true);
  }
  if (record.recorded) {
    const notice = record.recorded.notice;
    if (notice.producer !== mail.producer || notice.key !== mail.key || !same(notice.scope, scope))
      invalid("recorded notice scope mismatch");
    checkEntries(mail, notice.entries, true);
    if ("nativeEntries" in record && !same(nativeEntryIds(record.nativeEntries), nativeEntryIds(notice.entries)))
      invalid("recorded notice native proof mismatch");
    if (!record.requiredCallbacks.recorded && record.recorded.ack === "pending") invalid("optional recorded callback cannot owe ACK");
  }
  if ("evidence" in record) {
    const evidence = record.evidence;
    if (evidence.producer !== mail.producer || evidence.key !== mail.key || !same(evidence.scope, scope))
      invalid("terminal scope mismatch");
    if (!record.requiredCallbacks.terminal && record.terminalAck !== "acknowledged") invalid("optional terminal callback cannot owe ACK");
    if (record.requiredCallbacks.terminal && record.terminalAck === "acknowledged" && record.recorded?.ack === "pending")
      invalid("terminal ACK cannot precede recorded ACK");
    if (evidence.outcome === "fulfilled") {
      if (evidence.nativeEntryIds.length !== mail.messages.length || new Set(evidence.nativeEntryIds).size !== mail.messages.length)
        invalid("incomplete fulfilled native proof");
      if (record.recorded && !same(evidence.nativeEntryIds, nativeEntryIds(record.recorded.notice.entries)))
        invalid("fulfilled recorded native proof mismatch");
      if (record.requiredCallbacks.recorded && !record.recorded) invalid("fulfilled lost recorded debt");
      if (record.recorded?.ack === "superseded-by-cancel") invalid("fulfilled cannot supersede recorded");
    }
  }
}
export function parseMailboxSnapshot(value: unknown): MailboxSnapshot {
  const clone = cloneJson(value);
  validate(clone, MAILBOX_PENDING_SCHEMA_V1 as Schema, "snapshot");
  const snapshot = clone as MailboxSnapshot;
  const pending = new Map<string, PendingRecord>(),
    terminal = new Map<string, TerminalRecord>();
  for (const record of snapshot.pending) {
    const key = recordKey(record);
    if (pending.has(key) || record.acceptedRevision > snapshot.revision) invalid("invalid pending identity/revision");
    checkRecord(record, snapshot.session.id);
    pending.set(key, record);
  }
  const terminalIds = new Set<string>();
  for (const record of snapshot.terminal) {
    const key = recordKey(record.mail);
    if (terminal.has(key) || terminalIds.has(record.evidence.terminalId)) invalid("duplicate terminal identity");
    if (pending.has(key) && !sameMail(pending.get(key)!, record.mail)) invalid("terminal/pending identity conflict");
    checkRecord(record, snapshot.session.id);
    terminal.set(key, record);
    terminalIds.add(record.evidence.terminalId);
  }
  if (snapshot.attempt) {
    if (snapshot.attempt.sealedRevision > snapshot.revision) invalid("future attempt revision");
    const keys = snapshot.attempt.members.map(recordKey);
    if (new Set(keys).size !== keys.length) invalid("duplicate attempt member");
  }
  return deepFreeze(snapshot);
}
export function mailOnly(record: Mail): Mail {
  return {
    producer: record.producer,
    key: record.key,
    anchorEntryId: record.anchorEntryId,
    policy: record.policy,
    wake: record.wake,
    messages: record.messages,
  };
}
export function sameMail(a: Mail, b: Mail): boolean {
  return same(mailOnly(a), mailOnly(b));
}
