import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  buildSessionProjection, convertToLlm, CURRENT_SESSION_VERSION, sessionEntryToContextMessages,
  type CustomMessageEntry, type SessionEntry, type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  contextFingerprint, mapEffectiveTurns,
  type ContextIdentity, type EffectiveCapture, type ModelRef, type NativeMessageOrigin, type TurnAnchor,
} from "pi-session-runtime/effective-context";

import { parseForkTurns, type ForkTurns } from "pi-session-runtime/fork-turns";
export type { ForkTurns } from "pi-session-runtime/fork-turns";

export class EffectiveContextUnavailableError extends Error {
  readonly code = "effective-context-unavailable";
  readonly reason: string;
  constructor(reason: string) {
    super(`effective-context-unavailable: ${reason}; use fork_turns=none.`);
    this.name = "EffectiveContextUnavailableError"; this.reason = reason;
  }
}

/** Largest sequentially replayable prefix. A duplicate result invalidates its entire batch. */
export function stableMessagePrefix(messages: readonly Message[]): Message[] {
  let end = 0;
  let batchStart: number | undefined;
  let completedBatchStart: number | undefined;
  const pending = new Map<string, string>();
  const completed = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      if (pending.size || message.stopReason === "pending") break;
      completed.clear(); completedBatchStart = undefined;
      const calls = message.content.filter((block) => block.type === "toolCall");
      if (calls.length === 0) { end = index + 1; continue; }
      const ids = new Set<string>();
      if (calls.some((call) => ids.has(call.id) || (ids.add(call.id), false))) break;
      batchStart = index;
      for (const call of calls) pending.set(call.id, call.name);
    } else if (message.role === "toolResult") {
      if (completed.has(message.toolCallId) && completedBatchStart !== undefined) { end = Math.min(end, completedBatchStart); break; }
      if (pending.get(message.toolCallId) !== message.toolName) break;
      pending.delete(message.toolCallId); completed.add(message.toolCallId);
      if (pending.size === 0) { end = index + 1; completedBatchStart = batchStart; batchStart = undefined; }
    } else {
      if (pending.size) break;
      completed.clear(); completedBatchStart = undefined; end = index + 1;
    }
  }
  if (pending.size && batchStart !== undefined) end = Math.min(end, batchStart);
  return structuredClone(messages.slice(0, end));
}

function validateBranch(branch: readonly SessionEntry[]): void {
  const ids = new Map<string, number>();
  let previous: string | null = null;
  for (const [index, entry] of branch.entries()) {
    if (!entry.id || ids.has(entry.id) || entry.parentId !== previous) throw new EffectiveContextUnavailableError("invalid-native-branch");
    ids.set(entry.id, index); previous = entry.id;
    if (entry.type === "compaction" && !ids.has(entry.firstKeptEntryId)) throw new EffectiveContextUnavailableError("dangling-compaction-reference");
    if (entry.type === "context_edit" && (!ids.has(entry.targetId) || entry.targetId === entry.id)) throw new EffectiveContextUnavailableError("dangling-context-edit-reference");
  }
}

/** Public Pi projection resolves both repeated and self-retaining compactions and context edits. */
export function describeNativeContext(branch: readonly SessionEntry[]): NativeMessageOrigin[] {
  validateBranch(branch);
  const provenance = readSeedProvenance(branch);
  const projection = buildSessionProjection([...branch], branch.at(-1)?.id ?? null);
  return projection.entries.flatMap(({ sourceEntry, messages }) => describeEntry(sourceEntry, messages, provenance));
}

export function describeAuxiliaryPreamble(messages: Parameters<typeof convertToLlm>[0]): Message[] {
  // A native bash/custom/branch-summary input is a business turn; an unknown custom
  // injection is not proof of globally required memory. Only explicit summaries qualify.
  return convertToLlm(messages.filter((message) => message.role === "compactionSummary"));
}

const SEED_PROVENANCE = "pi-session-runtime-provenance-v1";
type OriginKind = NativeMessageOrigin["kind"];
interface SeedProvenance { version: 1; entries: Record<string, OriginKind> }
function readSeedProvenance(branch: readonly SessionEntry[]): Map<string, OriginKind> {
  const result = new Map<string, OriginKind>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== SEED_PROVENANCE) continue;
    const data = entry.data as Partial<SeedProvenance> | undefined;
    if (!data || data.version !== 1 || !data.entries || typeof data.entries !== "object" || Array.isArray(data.entries)) throw new EffectiveContextUnavailableError("invalid-seed-provenance");
    for (const [id, kind] of Object.entries(data.entries)) {
      if (!id || !["turn", "preamble", "body", "unknown"].includes(kind) || (result.has(id) && result.get(id) !== kind)) throw new EffectiveContextUnavailableError("invalid-seed-provenance");
      result.set(id, kind);
    }
  }
  return result;
}
function describeEntry(entry: SessionEntry, messages: Parameters<typeof convertToLlm>[0], provenance: ReadonlyMap<string, OriginKind>): NativeMessageOrigin[] {
  return convertToLlm(messages).map((message) => {
    let kind = provenance.get(entry.id);
    if (!kind) {
      if (entry.type === "compaction" || message.role === "system") kind = "preamble";
      else kind = message.role === "user" ? "turn" : "body";
    }
    return { message, kind, ...(kind === "turn" && message.role === "user" ? { turnId: entry.id } : {}) };
  });
}

export interface EffectiveContextSelection {
  messages: Message[];
  source: "none" | "request-capture" | "native-projection";
  exactRequestPrefix: boolean;
  reason?: string;
  turnAnchors: TurnAnchor[];
  preambleMessageIndices: number[];
  attachedMessageIndices: number[];
  turnMappingReliable: boolean;
}
export interface SelectEffectiveContextInput {
  mode: ForkTurns;
  identity: ContextIdentity;
  branch: readonly SessionEntry[];
  capture?: EffectiveCapture;
  requiresCapture: boolean;
  unavailableReason?: string;
  physicalModel?: ModelRef;
}

export function captureInvalidReason(capture: EffectiveCapture | undefined, input: SelectEffectiveContextInput): string | undefined {
  if (!capture) return input.unavailableReason ?? "no-capture";
  const identity = input.identity;
  if (capture.sessionId !== identity.sessionId || capture.generation !== identity.generation) return "session-generation-changed";
  if (contextFingerprint(capture.selectedModel) !== contextFingerprint(identity.selectedModel) || capture.thinkingLevel !== identity.thinkingLevel ||
      capture.toolLoadoutFingerprint !== identity.toolLoadoutFingerprint || capture.capabilityFingerprint !== identity.capabilityFingerprint ||
      (input.physicalModel && contextFingerprint(capture.physicalModel) !== contextFingerprint(input.physicalModel))) return "fingerprint-changed";
  const index = capture.leafId === null ? -1 : input.branch.findIndex((entry) => entry.id === capture.leafId);
  if (capture.leafId !== null && index < 0) return "capture-not-on-branch";
  if (input.branch.slice(index + 1).some((entry) => ["compaction", "context_edit", "branch_summary"].includes(entry.type))) return "projection-changed";
  return undefined;
}

function selectRecentTurns(selection: EffectiveContextSelection, count: number): EffectiveContextSelection {
  if (!selection.turnMappingReliable) throw new EffectiveContextUnavailableError("turn-mapping-unreliable (all remains available with a valid capture)");
  const anchors = selection.turnAnchors.filter((anchor) => anchor.messageIndex < selection.messages.length);
  const complete = anchors.map((anchor, index) => ({ start: anchor.messageIndex, end: anchors[index + 1]?.messageIndex ?? selection.messages.length }))
    .filter(({ start, end }) => selection.messages.slice(start, end).some((message) => message.role === "assistant" && message.stopReason !== "toolUse" && message.stopReason !== "pending"));
  const selected = complete.slice(-count);
  const keep = new Set(selection.preambleMessageIndices);
  for (const turn of selected) for (let index = turn.start; index < turn.end; index++) keep.add(index);
  const indices = [...keep].filter((index) => index < selection.messages.length).sort((a, b) => a - b);
  const remap = new Map(indices.map((index, newIndex) => [index, newIndex]));
  const messages = stableMessagePrefix(indices.map((index) => selection.messages[index]!));
  return {
    ...selection, messages, exactRequestPrefix: false,
    turnAnchors: anchors.filter((anchor) => remap.has(anchor.messageIndex)).map((anchor) => ({ ...anchor, messageIndex: remap.get(anchor.messageIndex)! })).filter((anchor) => anchor.messageIndex < messages.length),
    preambleMessageIndices: selection.preambleMessageIndices.flatMap((index) => remap.has(index) ? [remap.get(index)!] : []).filter((index) => index < messages.length),
    attachedMessageIndices: selection.attachedMessageIndices.flatMap((index) => remap.has(index) ? [remap.get(index)!] : []).filter((index) => index < messages.length),
  };
}

export function selectEffectiveContext(input: SelectEffectiveContextInput): EffectiveContextSelection {
  const mode = parseForkTurns(input.mode);
  if (mode === "none") return { messages: [], source: "none", exactRequestPrefix: false, turnAnchors: [], preambleMessageIndices: [], attachedMessageIndices: [], turnMappingReliable: true };
  validateBranch(input.branch);
  const reason = captureInvalidReason(input.capture, input);
  let selection: EffectiveContextSelection;
  if (!reason && input.capture) {
    const capture = input.capture;
    const at = capture.leafId === null ? -1 : input.branch.findIndex((entry) => entry.id === capture.leafId);
    const provenance = readSeedProvenance(input.branch);
    const tail = input.branch.slice(at + 1).flatMap((entry) => describeEntry(entry, sessionEntryToContextMessages(entry), provenance));
    const messages = stableMessagePrefix([...capture.normalizedMessages, ...tail.map((origin) => origin.message)]);
    const tailMapping = mapEffectiveTurns(tail.map((origin) => origin.message), tail);
    const offset = capture.normalizedMessages.length;
    selection = {
      messages, source: "request-capture", exactRequestPrefix: messages.length >= offset,
      turnAnchors: [...capture.turnAnchors, ...tailMapping.turnAnchors.map((anchor) => ({ ...anchor, messageIndex: anchor.messageIndex + offset }))].filter((anchor) => anchor.messageIndex < messages.length),
      preambleMessageIndices: [...capture.preambleMessageIndices, ...tailMapping.preambleMessageIndices.map((index) => index + offset)].filter((index) => index < messages.length),
      attachedMessageIndices: [...capture.attachedMessageIndices, ...tailMapping.attachedMessageIndices.map((index) => index + offset)].filter((index) => index < messages.length),
      turnMappingReliable: capture.turnMappingReliable && tailMapping.turnMappingReliable,
    };
  } else {
    if (input.requiresCapture) throw new EffectiveContextUnavailableError(reason!);
    const origins = describeNativeContext(input.branch);
    const messages = stableMessagePrefix(origins.map((origin) => origin.message));
    selection = { messages, source: "native-projection", exactRequestPrefix: false, reason, ...mapEffectiveTurns(messages, origins) };
  }
  return typeof mode === "number" ? selectRecentTurns(selection, mode) : selection;
}

export interface NativeChildSnapshot {
  header: SessionHeader;
  entries: SessionEntry[];
  inheritedEntryIds: string[];
  boundaryId: string;
  jsonl: string;
}
export function buildNativeChildSnapshot(input: {
  selection: EffectiveContextSelection;
  cwd: string;
  boundary: Pick<CustomMessageEntry, "customType" | "content" | "details">;
  model?: { provider: string; modelId: string; thinkingLevel: string };
}): NativeChildSnapshot {
  const timestamp = new Date().toISOString();
  const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp, cwd: input.cwd };
  const messages = stableMessagePrefix(input.selection.messages);
  const used = new Set<string>();
  const id = () => { let value: string; do { value = randomBytes(16).toString("hex"); } while (used.has(value)); used.add(value); return value; };
  const inheritedEntryIds = messages.map(() => id());
  const boundaryId = id();
  const turns = new Set(input.selection.turnAnchors.map((anchor) => anchor.messageIndex));
  const preambles = new Set(input.selection.preambleMessageIndices);
  const attached = new Set(input.selection.attachedMessageIndices);
  const provenance: SeedProvenance = { version: 1, entries: { [boundaryId]: "body" } };
  for (const [index, message] of messages.entries()) if (message.role === "user") {
    provenance.entries[inheritedEntryIds[index]!] = preambles.has(index) ? "preamble" : attached.has(index) ? "body" : turns.has(index) && input.selection.turnMappingReliable ? "turn" : "unknown";
  }
  const entries: SessionEntry[] = [];
  const append = (entry: SessionEntry) => entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null });
  // First so any descendant branch that retains inherited messages also retains their
  // provenance. References use only freshly allocated IDs, never parent session IDs.
  append({ type: "custom", customType: SEED_PROVENANCE, data: provenance, id: id(), parentId: null, timestamp });
  messages.forEach((message, index) => append({ type: "message", id: inheritedEntryIds[index]!, parentId: null, timestamp, message }));
  append({ ...input.boundary, type: "custom_message", id: boundaryId, parentId: null, timestamp, display: false });
  if (input.model) {
    append({ type: "model_change", id: id(), parentId: null, timestamp, provider: input.model.provider, modelId: input.model.modelId });
    append({ type: "thinking_level_change", id: id(), parentId: null, timestamp, thinkingLevel: input.model.thinkingLevel });
  }
  return { header, entries, inheritedEntryIds, boundaryId, jsonl: [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n" };
}
/** Owner chooses a private destination and cleanup policy. Never overwrites a parent or existing seed. */
export async function writeNativeChildSnapshot(path: string, snapshot: NativeChildSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, snapshot.jsonl, { flag: "wx", mode: 0o600 });
}
