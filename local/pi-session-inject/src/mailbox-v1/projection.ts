import { realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAgentDir, type ContextEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAILBOX_ABI_VERSION, MAILBOX_HOLDER_KEY, MAILBOX_TRANSPORT_BUILD_ID } from "./constants.js";
import { checkEngineHolder } from "./engine-loader.js";
import { MailboxError } from "./errors.js";
import { readRegistry } from "./registry.js";
import { recordKey, same } from "./json.js";
import { snapshotPath } from "./paths.js";
import { fileVersion, readVersionedText, sameFileVersion, type FileVersion } from "./read-version.js";
import { readDiskSession, terminalIndex, type IndexedTerminal } from "./proof.js";
import { parseMailboxSnapshot } from "./validation.js";
import type { BindMailboxOptions, Mail, PendingRecord, MailboxHolder, MailboxSessionIdentity, MailboxSnapshot } from "./types.js";
import type { Slot } from "./runtime.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
async function canonicalReadOnly(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) { if (missing(error)) return resolve(path); throw error; }
}
function empty(session: MailboxSessionIdentity): MailboxSnapshot {
  return { version: 1, session, revision: 0, pending: [], terminal: [], suspended: null };
}
interface SnapshotRead { path: string; version: FileVersion; snapshot: MailboxSnapshot }
interface Reader {
  session: MailboxSessionIdentity;
  snapshot?: SnapshotRead | undefined;
  loading?: { path: string; promise: Promise<SnapshotRead | null> } | undefined;
}
const readers = new WeakMap<ExtensionContext["sessionManager"], Reader>();
async function readSnapshot(agentDir: string, reader: Reader): Promise<MailboxSnapshot> {
  const { session } = reader, path = snapshotPath(agentDir, session.id);
  try {
    const version = await fileVersion(path);
    let read = reader.snapshot;
    if (read?.path !== path || !sameFileVersion(read.version, version)) {
      reader.snapshot = undefined;
      if (reader.loading?.path !== path) reader.loading = { path, promise: (async () => {
        const source = await readVersionedText(path);
        return source ? { path, version: source.version, snapshot: parseMailboxSnapshot(JSON.parse(source.text)) } : null;
      })() };
      const flight = reader.loading;
      try { read = await flight.promise ?? undefined; }
      finally { if (reader.loading === flight) reader.loading = undefined; }
      if (read && !sameFileVersion(read.version, await fileVersion(path))) return readSnapshot(agentDir, reader);
      reader.snapshot = read;
    }
    if (!read) {
      try { await stat(dirname(path)); } catch (error) { if (missing(error)) return empty(session); throw error; }
      throw new MailboxError("unverifiable-proof", "mailbox directory exists without a readable snapshot");
    }
    if (read.snapshot.session.id !== session.id || read.snapshot.session.file !== session.file)
      throw new MailboxError("conflict", "mailbox projection snapshot/session identity mismatch");
    return read.snapshot;
  } catch (error) { reader.snapshot = undefined; throw error; }
}

/** Read only: no binding/election, writer/engine activation, callbacks, native sends or hold release. */
export async function filterMailboxMessages(
  ctx: Pick<ExtensionContext, "sessionManager" | "cwd">,
  messages: readonly ContextEvent["messages"][number][], options: BindMailboxOptions = {},
): Promise<ContextEvent["messages"]> {
  checkEngineHolder();
  const agentDir = await canonicalReadOnly(options.agentDir ?? getAgentDir());
  const manager = ctx.sessionManager;
  const identity: MailboxSessionIdentity = { id: manager.getSessionId(), file: manager.getSessionFile() ?? null, cwd: ctx.cwd };
  let reader = readers.get(manager);
  if (!reader || !same(reader.session, identity)) {
    reader = { session: Object.freeze(identity) };
    readers.set(manager, reader);
  }
  const session = reader.session, leaf = manager.getLeafId();
  const holder = readRegistry(Symbol.for(MAILBOX_HOLDER_KEY)) as MailboxHolder | undefined;
  if (holder !== undefined && (!holder || holder.version !== MAILBOX_ABI_VERSION || holder.transportBuildId !== MAILBOX_TRANSPORT_BUILD_ID
    || !(holder.slots instanceof Map) || typeof holder.bind !== "function"))
    throw new MailboxError("holder-incompatible", "mailbox projection holder ABI/build/method mismatch");
  const candidate = holder?.slots.get(JSON.stringify([agentDir, session.id])) as Slot | undefined;
  if (candidate && !candidate.retired && (candidate.sessionManager !== manager || candidate.session.file !== session.file))
    throw new MailboxError("stale-binding", "mailbox projection does not own this session identity");
  const slot = candidate && !candidate.retired && candidate.owner ? candidate : undefined;
  const generation = slot?.bindingGeneration, epoch = slot?.ownerEpoch;
  if (slot) await slot.ready; // Only await an existing owner activation; never start one.
  const current = () => {
    if (readRegistry(Symbol.for(MAILBOX_HOLDER_KEY)) !== holder
      || manager.getSessionId() !== session.id || (manager.getSessionFile() ?? null) !== session.file || manager.getLeafId() !== leaf
      || slot && (slot.retired || !slot.current(undefined, epoch, generation)))
      throw new MailboxError("stale-binding", "mailbox projection session changed while reading");
  };
  for (;;) {
    current();
    const snapshot = slot ? slot.snapshot : await readSnapshot(agentDir, reader);
    const disk = await readDiskSession(slot?.session ?? session);
    if (session.file && !disk && (snapshot.pending.length || snapshot.terminal.length || manager.getBranch().length))
      throw new MailboxError("unverifiable-proof", "mailbox projection cannot read the original session");
    current();
    if (slot ? snapshot !== slot.snapshot : !same(snapshot, await readSnapshot(agentDir, reader))) continue;
    current();
    return filterSnapshotMessages(messages, snapshot, terminalIndex(disk, session.id), session.id, record =>
      !slot || slot.recoveryHeldKeys.has(recordKey(record)) || !!record.legacyImport || slot.proofErrors.has(recordKey(record))
        || slot.sourceErrors.has(recordKey(record)) || slot.failedIngress.has(recordKey(record))
        || !!slot.run?.heldSources.has(record.producer) || !slot.registration(record.producer));
  }
}

// Readonly policy uses persisted facts and known live refusals, never reruns producer
// guards or grants authority. The delivery owner rechecks guards for every real request.
function messageMatches(value: unknown, carrier: Mail["messages"][number]): boolean {
  const message = value as { role?: string; customType?: string; content?: unknown; display?: boolean; details?: unknown };
  return message.role === "custom" && message.customType === carrier.customType && same(message.content, carrier.content)
    && same(message.details, carrier.details) && message.display === carrier.display;
}

/** Conservative readonly filter. Retained messages keep their exact object/byte identity. */
function filterSnapshotMessages(
  messages: readonly ContextEvent["messages"][number][], snapshot: MailboxSnapshot,
  index: ReadonlyMap<string, IndexedTerminal>, sessionId: string, held: (record: PendingRecord) => boolean,
): ContextEvent["messages"] {
  const terminals = new Map(
    [...snapshot.terminal, ...index.values()]
      .filter((record) => record.evidence.scope.sessionId === sessionId)
      .map((record) => [recordKey(record.mail), record]),
  );
  const cancelledCarriers = [...terminals.values()]
    .filter((record) => record.evidence.outcome === "cancelled")
    .flatMap((record) => [...record.mail.messages]);
  const fulfilledCarriers = [...terminals.values()]
    .filter((record) => record.evidence.outcome === "fulfilled")
    .flatMap((record) => [...record.mail.messages]);
  const pending = snapshot.pending.filter(record => !terminals.has(recordKey(record)));
  const retainedCarriers = [...pending.filter(record => !held(record)).flatMap(record => [...record.messages]), ...fulfilledCarriers];
  const blockedCarriers = [...pending.filter(held).flatMap(record => [...record.messages]), ...cancelledCarriers];
  return messages.filter(message => !blockedCarriers.some(carrier => messageMatches(message, carrier))
    || retainedCarriers.some(carrier => messageMatches(message, carrier)));
}
