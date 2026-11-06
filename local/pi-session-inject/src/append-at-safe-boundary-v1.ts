/**
 * Append a custom message at a safe idle boundary.
 *
 * The "safe-idle-turn" mode: wait for idle, confirm authority, confirm no
 * unresolved tool calls, then `send` with `deliverAs:"steer"` and wait for the
 * native entry to land. Retained for explicit legacy idle-boundary callers.
 *
 * Production mailbox producers use mailbox-v1/light and must not fall back to
 * this primitive. The transport owns their delivery/replay/ACK semantics;
 * `openTailToolCallIds` remains the shared tail predicate.
 */

import { createHash } from "node:crypto";
import type { IdleAppendBoundary, LiveMessagePort } from "./types.js";
import { openTailToolCallIds, type BranchSession } from "./open-tail-tool-calls-v1.js";

export interface SafeAppendOptions {
  /** Custom message type, e.g. "scheduler-injection-v1". */
  customType: string;
  /** Message body. */
  content: string;
  /** Details object; must include the identity field for replay matching. */
  details?: unknown;
  /** Stable identity value (e.g. `${taskId}:${scheduledTime}`) for replay. */
  identityKey: string;
  /** Field name in `details` holding `identityKey`. */
  identityField: string;
  /** sha256 hex of the content, to verify an existing entry matches. */
  contentDigest: string;
  /** Request a model turn after appending. */
  triggerTurn: boolean;
  /** steer = into current turn; nextTurn = new turn. Default steer. */
  deliverAs?: "steer" | "nextTurn";
  /** Deadline to wait for the native entry to appear (ms). Default 5000. */
  entryDeadlineMs?: number;
}

export type SafeAppendResult =
  | { state: "injected"; entryId: string }
  | { state: "not-appended" }
  | { state: "append-unknown" };

export interface NativeEntryProof {
  entryId: string;
  content: string;
}

interface NativeEntry {
  id: string;
  content: string;
  details: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digestMatches(content: string, expectedDigest: string): boolean {
  return createHash("sha256").update(content).digest("hex") === expectedDigest;
}

function findExisting(
  session: BranchSession,
  customType: string,
  identityField: string,
  identityKey: string,
): NativeEntry[] {
  const out: NativeEntry[] = [];
  for (const entry of session.getBranch()) {
    if (entry.type !== "custom_message" || entry.customType !== customType) continue;
    const details = entry.details;
    if (!isRecord(details)) continue;
    if (details[identityField] !== identityKey) continue;
    const content = typeof entry.content === "string" ? entry.content : "";
    out.push({ id: entry.id, content, details: entry.details });
  }
  return out;
}

/**
 * Prove that exactly one native entry with this stable identity exists.
 *
 * This never appends. It is for crash recovery after an append may have
 * reached the session but its daemon acknowledgement was lost. A matching
 * identity with different content is a conflict; duplicate identities are
 * likewise fail-closed.
 */
export function proveNativeEntry(
  session: BranchSession,
  customType: string,
  identityField: string,
  identityKey: string,
  content: string,
  contentDigest: string,
): NativeEntryProof | undefined {
  const matches = findExisting(session, customType, identityField, identityKey);
  if (matches.length > 1) throw new Error(`duplicate ${customType} entry for ${identityKey}`);
  if (matches.length === 0) return undefined;
  const entry = matches[0]!;
  if (entry.content !== content || !digestMatches(entry.content, contentDigest)) {
    throw new Error(`${customType} replay conflicts with native entry`);
  }
  return { entryId: entry.id, content: entry.content };
}

/**
 * Append at a safe idle boundary.
 *
 * 1. wait for idle → confirm authority → confirm idle → no open tool calls
 * 2. scan for an existing entry with this identity (replay/idempotency)
 *    - exactly one + content matches → return injected (proof)
 *    - exactly one + content mismatch → throw (caller nack content-conflict)
 *    - more than one → throw (duplicate)
 * 3. send via the live port
 * 4. wait for the native entry to appear (deadline)
 *    - appeared → injected
 *    - deadline → append-unknown
 *    - authority lost during wait → append-unknown
 */
export async function appendAtSafeBoundary(
  session: BranchSession,
  boundary: IdleAppendBoundary,
  port: LiveMessagePort,
  options: SafeAppendOptions,
): Promise<SafeAppendResult> {
  // 1. safe point
  await boundary.waitForIdle();
  if (!boundary.isCurrent()) return { state: "not-appended" };
  if (!boundary.isIdle()) return { state: "not-appended" };
  const open = openTailToolCallIds(session);
  if (open.length > 0) return { state: "not-appended" };

  // 2. replay check
  const existing = proveNativeEntry(
    session,
    options.customType,
    options.identityField,
    options.identityKey,
    options.content,
    options.contentDigest,
  );
  if (existing) return { state: "injected", entryId: existing.entryId };

  // 3. send
  port.send(
    {
      customType: options.customType,
      content: options.content,
      display: true,
      details: options.details,
    },
    { triggerTurn: options.triggerTurn, deliverAs: options.deliverAs ?? "steer" },
  );

  // 4. wait for native entry
  const deadline = Date.now() + (options.entryDeadlineMs ?? 5_000);
  for (;;) {
    if (!boundary.isCurrent()) return { state: "append-unknown" };
    const matches = findExisting(session, options.customType, options.identityField, options.identityKey);
    if (matches.length > 1) throw new Error(`duplicate ${options.customType} entry after send`);
    if (matches.length === 1) {
      const entry = matches[0]!;
      if (entry.content !== options.content) throw new Error(`${options.customType} native entry content mismatch`);
      return { state: "injected", entryId: entry.id };
    }
    if (Date.now() >= deadline) return { state: "append-unknown" };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
