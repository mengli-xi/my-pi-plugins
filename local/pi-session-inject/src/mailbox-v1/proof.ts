import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isReadRace, MailboxError } from "./errors.js";
import { checkpoint } from "./checkpoint.js";
import { fileVersion, readVersionedText, sameFileVersion, requireSameFileVersion, READ_VERSION_ATTEMPTS, type FileVersion } from "./read-version.js";
import { MAILBOX_CUSTOM_TYPES } from "./types.js";
import type { Mail, MailboxDeliveryReceipt, MailboxSessionIdentity, NativeEntryRef, TerminalEvidence } from "./types.js";
import { checkEntries, cloneJson, invalid, recordKey, same, validateDefinition } from "./validation.js";

export function nativeEquals(entry: SessionEntry, message: Mail["messages"][number]): boolean {
  if (entry.type !== "custom_message") return false;
  const native = { customType: entry.customType, content: entry.content, display: entry.display,
    ...(entry.details === undefined ? {} : { details: entry.details }) };
  return same(native, message);
}
export function verifyNative(mail: Mail, entries: readonly NativeEntryRef[], branch: readonly SessionEntry[], complete = false): void {
  checkEntries(mail, entries, complete);
  for (const proof of entries) {
    const entry = branch.find(candidate => candidate.id === proof.entryId);
    if (!entry || !nativeEquals(entry, mail.messages[proof.messageIndex]!)) throw new MailboxError("unverifiable-proof", "native proof does not match original carrier/branch");
  }
}
export function onBranch(mail: Mail, branchEntryId: string | null, branch: readonly SessionEntry[]): boolean {
  const anchor = branchEntryId ?? mail.anchorEntryId;
  return anchor === null || branch.some(entry => entry.id === anchor);
}
export interface DiskSession { readonly entries: readonly SessionEntry[]; readonly byId: ReadonlyMap<string, SessionEntry> }
interface DiskRead {
  readonly file: string; readonly headerId: string; readonly version: FileVersion; readonly disk: DiskSession;
  readonly prefix: { length: number; hash: string } | null;
}
interface DiskReadState { current: DiskRead | undefined; reading: Promise<DiskRead | null> | undefined }
// A binding owns at most one parsed version, never a global path/history archive.
const diskReads = new WeakMap<MailboxSessionIdentity, DiskReadState>();
export function releaseDiskSession(identity: MailboxSessionIdentity): void { diskReads.delete(identity); }
async function readSessionVersion(state: DiskReadState, file: string): Promise<DiskRead | null> {
  try {
    const version = await fileVersion(file);
    if (state.current?.file === file && sameFileVersion(state.current.version, version)) return state.current;
    const previous = state.current;
    state.current = undefined;
    // Always read stable bytes from disk. Metadata growth alone cannot prove
    // append-only history: a writer may also have changed the old prefix.
    const source = version === null ? null : await readVersionedText(file);
    if (!source) return null;
    let digest = createHash("sha256"), reuse: DiskRead | null = null;
    if (previous?.file === file && previous.prefix !== null
      && previous.version.dev === source.version.dev && previous.version.ino === source.version.ino
      && previous.version.size < source.version.size && source.text.length >= previous.prefix.length) {
      digest.update(source.text.slice(0, previous.prefix.length));
      if (digest.copy().digest("hex") === previous.prefix.hash) reuse = previous;
      else digest = createHash("sha256");
    }
    const text = source.text.slice(reuse?.prefix?.length ?? 0);
    // Only newline-terminated text can become a reusable prefix, so unterminated text
    // skips the digest entirely instead of paying one more full-text SHA-256.
    const terminated = source.text.endsWith("\n");
    if (terminated) digest.update(text); // reuse the verified prefix hash state, not a second full hash
    const rows = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as FileEntry);
    const header = reuse ? null : rows.shift();
    if (!reuse && (!header || header.type !== "session" || typeof header.id !== "string")) throw new MailboxError("unverifiable-proof", "session disk header does not match mailbox target");
    const tail = rows as SessionEntry[];
    const byId = new Map(reuse?.disk.byId);
    for (const entry of tail) {
      if (typeof entry.id !== "string" || typeof entry.parentId !== "string" && entry.parentId !== null || byId.has(entry.id))
        throw new MailboxError("unverifiable-proof", "malformed session disk history");
      byId.set(entry.id, entry);
    }
    const entries = reuse ? [...reuse.disk.entries, ...tail] : tail;
    const current = { file, headerId: reuse?.headerId ?? header!.id, version: source.version, disk: { entries, byId },
      // A final row without a newline may be extended; parse it in full next time.
      prefix: terminated ? { length: source.text.length, hash: digest.digest("hex") } : null };
    state.current = current;
    return current;
  } catch (error) { state.current = undefined; throw error; }
}
export async function readDiskSession(identity: MailboxSessionIdentity): Promise<DiskSession | null> {
  if (!identity.file) { releaseDiskSession(identity); return null; }
  let state = diskReads.get(identity);
  if (!state) { state = { current: undefined, reading: undefined }; diskReads.set(identity, state); }
  for (let attempt = 0; attempt < READ_VERSION_ATTEMPTS; attempt++) {
    const file: string = identity.file;
    const reading = state.reading ??= readSessionVersion(state, file);
    let result: DiskRead | null | undefined;
    try {
      result = await reading;
      // A joining caller may observe a resolved read after another append.
      // Check at this caller's completion, including a previously missing file.
      const version = await fileVersion(file);
      // Reuse parsed bytes, not the authority of an earlier caller's identity.
      if (file !== identity.file || result && (result.file !== file || result.headerId !== identity.id)) {
        throw new MailboxError("unverifiable-proof", "session disk header does not match mailbox target");
      }
      requireSameFileVersion(result?.version ?? null, version);
      return result?.disk ?? null;
    } catch (error) {
      if (state.current === result) state.current = undefined;
      if (!isReadRace(error)) throw error;
      if (attempt === READ_VERSION_ATTEMPTS - 1) throw error;
    } finally { if (state.reading === reading) state.reading = undefined; }
  }
  throw new MailboxError("read-race", "session kept changing while reading mailbox proof");
}
export function diskBranch(disk: DiskSession, leafId: string): SessionEntry[] {
  const reverse: SessionEntry[] = [], seen = new Set<string>();
  let next: string | null = leafId;
  while (next !== null) {
    if (seen.has(next)) throw new MailboxError("unverifiable-proof", "cyclic disk history");
    seen.add(next);
    const entry = disk.byId.get(next);
    if (!entry) throw new MailboxError("unverifiable-proof", "missing disk branch ancestor");
    reverse.push(entry); next = entry.parentId;
  }
  return reverse.reverse();
}
export function successfulAssistant(entry: SessionEntry | undefined): boolean {
  return !!entry && entry.type === "message" && entry.message.role === "assistant"
    && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted";
}
export interface IndexedTerminal {
  readonly mail: Mail;
  readonly branchEntryId: string | null;
  readonly evidence: TerminalEvidence;
  readonly backingReceiptEntryId: string;
}
export function terminalIndex(disk: DiskSession | null, sessionId: string): Map<string, IndexedTerminal> {
  const index = new Map<string, IndexedTerminal>();
  if (!disk) return index;
  for (const entry of disk.entries) {
    if (entry.type !== "custom" || entry.customType !== MAILBOX_CUSTOM_TYPES.delivery) continue;
    const data = entry.data as MailboxDeliveryReceipt | undefined;
    // Parent/fork historical receipts belong to their original session only.
    if (!data || data.sessionId !== sessionId) continue;
    if (data.version !== 1 || !Array.isArray(data.terminals)) throw new MailboxError("unverifiable-proof", "malformed mailbox delivery receipt");
    for (const item of data.terminals as MailboxDeliveryReceipt["terminals"]) {
      validateDefinition(item.mail, "mail");
      const evidence = item.evidence.outcome === "fulfilled" ? { ...item.evidence, receiptEntryId: entry.id } : item.evidence;
      validateDefinition(evidence, "terminalEvidence");
      if (evidence.scope.sessionId !== sessionId || evidence.scope.anchorEntryId !== item.mail.anchorEntryId || recordKey(evidence) !== recordKey(item.mail)) invalid("delivery receipt scope conflict");
      const branch = diskBranch(disk, entry.id);
      if (!onBranch(item.mail, item.branchEntryId, branch)) throw new MailboxError("unverifiable-proof", "delivery receipt origin is not on its branch");
      if (evidence.outcome === "fulfilled") {
        const assistant = disk.byId.get(evidence.assistantEntryId);
        if (!successfulAssistant(assistant)) throw new MailboxError("unverifiable-proof", "delivery assistant proof missing");
        const requestBranch = diskBranch(disk, evidence.assistantEntryId);
        verifyNative(item.mail, evidence.nativeEntryIds.map((entryId, messageIndex) => ({ entryId, messageIndex })), requestBranch, true);
        if (!branch.some(candidate => candidate.id === evidence.assistantEntryId)) throw new MailboxError("unverifiable-proof", "delivery assistant belongs to sibling branch");
      }
      const key = recordKey(item.mail), previous = index.get(key);
      if (previous && (!same(previous.mail, item.mail) || !same(previous.evidence, evidence))) throw new MailboxError("unverifiable-proof", "conflicting delivery receipts");
      index.set(key, { mail: cloneJson(item.mail), branchEntryId: item.branchEntryId, evidence: cloneJson(evidence), backingReceiptEntryId: entry.id });
    }
  }
  return index;
}
/** Public appendEntry is void. Find its generated ID through public branch,
 * then require a disk readback before it can replace the snapshot's last copy. */
export async function appendDelivery(
  pi: ExtensionAPI, ctx: ExtensionContext, identity: MailboxSessionIdentity,
  item: MailboxDeliveryReceipt["terminals"][number],
): Promise<IndexedTerminal | null> {
  let entry = ctx.sessionManager.getBranch().find(candidate => candidate.type === "custom" && candidate.customType === MAILBOX_CUSTOM_TYPES.delivery
    && (candidate.data as MailboxDeliveryReceipt | undefined)?.terminals?.some(terminal => terminal.evidence.terminalId === item.evidence.terminalId));
  if (!entry) {
    checkpoint("before-delivery");
    pi.appendEntry(MAILBOX_CUSTOM_TYPES.delivery, { version: 1, sessionId: identity.id, terminals: [item] } satisfies MailboxDeliveryReceipt);
    checkpoint("after-delivery");
    entry = ctx.sessionManager.getBranch().find(candidate => candidate.type === "custom" && candidate.customType === MAILBOX_CUSTOM_TYPES.delivery
      && (candidate.data as MailboxDeliveryReceipt | undefined)?.terminals?.some(terminal => terminal.evidence.terminalId === item.evidence.terminalId));
  }
  if (!entry) throw new MailboxError("unverifiable-proof", "host did not append mailbox delivery receipt");
  const indexed = terminalIndex(await readDiskSession(identity), identity.id).get(recordKey(item.mail));
  return indexed?.evidence.terminalId === item.evidence.terminalId ? indexed : null;
}

/** Legacy no-receipt formats may name their own native carrier as source receipt.
 * Reject a projection boundary that removes it before the claimed assistant. */
export function verifyLegacyRequest(mail: Mail, proofs: readonly NativeEntryRef[], sourceReceiptEntryId: string, assistantEntryId: string, disk: DiskSession): void {
  const source = disk.byId.get(sourceReceiptEntryId);
  if (!source || source.type !== "custom" && source.type !== "custom_message") throw new MailboxError("unverifiable-proof", "legacy source receipt missing");
  if (source.type === "custom_message" && !proofs.some(proof => proof.entryId === source.id)) throw new MailboxError("unverifiable-proof", "legacy source carrier is not this mail's own native proof");
  const branch = diskBranch(disk, assistantEntryId);
  if (!successfulAssistant(disk.byId.get(assistantEntryId))) throw new MailboxError("unverifiable-proof", "legacy assistant is not successful");
  verifyNative(mail, proofs, branch, true);
  const sourceBranch = diskBranch(disk, sourceReceiptEntryId);
  if (!branch.some(entry => entry.id === source.id) && !sourceBranch.some(entry => entry.id === assistantEntryId)) throw new MailboxError("unverifiable-proof", "legacy source and assistant have different lineage");
  const positions = proofs.map(proof => branch.findIndex(entry => entry.id === proof.entryId));
  for (const [index, entry] of branch.entries()) {
    if (entry.type === "context_edit" && proofs.some(proof => proof.entryId === entry.targetId)) throw new MailboxError("unverifiable-proof", "legacy native projection was edited");
    if (entry.type === "compaction" && positions.some(position => position < index && (entry.firstKeptEntryId === null || position < branch.findIndex(candidate => candidate.id === entry.firstKeptEntryId)))) throw new MailboxError("unverifiable-proof", "legacy carrier was compacted before assistant proof");
  }
}
