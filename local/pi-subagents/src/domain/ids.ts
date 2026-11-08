import { createHash, randomBytes } from "node:crypto";
import type {
  AgentId,
  BarrierId,
  CleanupId,
  CompletionId,
  DomainId,
  IdPrefix,
  InboxId,
  MessageId,
  OutboxId,
  OwnerEventId,
  ReceiptId,
  TaskId,
  TransactionId,
} from "./types.js";

const SUFFIX_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const ENCODED_ID_PATTERN = /^(agt|tsk|msg|bar|cmp|inb|out|evt|txn|rcp|cln)_([A-Za-z0-9_-]{22})$/u;
const MAIN_KEY_PATTERN = /^main_[A-Za-z0-9_-]{32}$/u;

export type IdForPrefix<P extends IdPrefix> = P extends "agt"
  ? AgentId
  : P extends "tsk"
    ? TaskId
    : P extends "bar"
      ? BarrierId
      : P extends "msg"
        ? MessageId
      : P extends "cmp"
        ? CompletionId
        : P extends "inb"
          ? InboxId
          : P extends "out"
            ? OutboxId
            : P extends "evt"
              ? OwnerEventId
              : P extends "txn"
                ? TransactionId
                : P extends "rcp"
                  ? ReceiptId
                  : P extends "cln"
                    ? CleanupId
                    : DomainId;

export function encodeDomainId<P extends IdPrefix>(prefix: P, bytes: Uint8Array): IdForPrefix<P> {
  if (bytes.byteLength !== 16) throw new Error("domain id entropy must be exactly 128 bits");
  const suffix = Buffer.from(bytes).toString("base64url");
  if (!SUFFIX_PATTERN.test(suffix)) throw new Error("domain id encoding is not canonical base64url");
  return `${prefix}_${suffix}` as IdForPrefix<P>;
}

export function generateDomainId<P extends IdPrefix>(prefix: P): IdForPrefix<P> {
  return encodeDomainId(prefix, randomBytes(16));
}

export function allocateUniqueDomainId<P extends IdPrefix>(
  prefix: P,
  exists: (candidate: IdForPrefix<P>) => boolean,
  random: (size: number) => Uint8Array = randomBytes,
): IdForPrefix<P> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = encodeDomainId(prefix, random(16));
    if (!exists(candidate)) return candidate;
  }
  throw new Error("[subagent/id-generation-failed] could not allocate a unique domain id");
}

export function isDomainId(value: unknown, prefix?: IdPrefix): value is DomainId {
  if (typeof value !== "string") return false;
  const match = ENCODED_ID_PATTERN.exec(value);
  return Boolean(match && (!prefix || match[1] === prefix));
}

export function assertDomainId<P extends IdPrefix>(value: unknown, prefix: P): asserts value is IdForPrefix<P> {
  if (!isDomainId(value, prefix)) throw new Error(`id must match ${prefix}_[A-Za-z0-9_-]{22}`);
}

export function mainKey(mainSessionId: string): string {
  if (typeof mainSessionId !== "string" || mainSessionId.length === 0) {
    throw new Error("main session id must be a non-empty string");
  }
  const digest = createHash("sha256")
    .update("pi-subagents/main-key/v1\0", "utf8")
    .update(mainSessionId, "utf8")
    .digest("base64url");
  return `main_${digest.slice(0, 32)}`;
}

export function isMainKey(value: unknown): value is string {
  return typeof value === "string" && MAIN_KEY_PATTERN.test(value);
}
