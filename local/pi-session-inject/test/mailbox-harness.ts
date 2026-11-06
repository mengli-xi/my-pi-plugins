import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand, SessionEntry } from "@earendil-works/pi-coding-agent";
import { bindMailbox, MAILBOX_HOLDER_KEY, type Mail, type MailboxSnapshot, type ProducerId, type ProducerRegistration } from "../src/mailbox-v1/light.js";
import { snapshotPath } from "../src/mailbox-v1/paths.js";

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function until(predicate: () => boolean, label = "mailbox condition"): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
export async function clearMailboxes(): Promise<void> {
  const symbol = Symbol.for(MAILBOX_HOLDER_KEY), root = globalThis as any;
  const holder = root[symbol];
  if (holder?.slots instanceof Map) for (const slot of holder.slots.values()) if (slot.retire) await slot.retire();
  delete root[symbol];
}
/** Persisted before the first bind: represents transport from an earlier process. */
export async function recoveredPending(agentDir: string, manager: SessionManager, mails: readonly Mail[]): Promise<void> {
  const snapshot: MailboxSnapshot = {
    version: 1, session: { id: manager.getSessionId(), file: manager.getSessionFile() ?? null, cwd: manager.getCwd() }, revision: 1,
    suspended: null, terminal: [], pending: mails.map(mail => ({ ...mail, acceptedRevision: 1,
      requiredCallbacks: { recorded: false, terminal: false }, branchEntryId: null, nativeEntries: [], recorded: null })),
  };
  const path = snapshotPath(agentDir, snapshot.session.id); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot));
}
/** Uses real public SessionManager persistence; only the Pi event/native queues
 * are controlled here. Actual host ordering is separately tested with pi-binary. */
export async function harness(options: { directory?: string; manager?: SessionManager; persist?: boolean } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "mailbox-test-"));
  const cwd = join(directory, "cwd"), agentDir = join(directory, "agent");
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
  const manager = options.manager ?? SessionManager.create(cwd, join(directory, "sessions"));
  if (options.persist && manager.getBranch().length === 0) manager.appendMessage({ role: "user", content: "initial", timestamp: Date.now() });
  const handlers = new Map<string, Set<(event: any, ctx: any) => any>>();
  const commands = new Map<string, { definition: Omit<RegisteredCommand, "name" | "sourceInfo">; sourceInfo: any }>();
  const sends: { message: any; options: any }[] = [], queue: any[] = [], notices: string[] = [];
  let busy = false;
  const ctx = {
    sessionManager: manager, cwd, isIdle: () => !busy, signal: undefined, hasPendingMessages: () => queue.length > 0,
    ui: { notify: (text: string) => notices.push(text) }, mode: "rpc", hasUI: true,
  } as unknown as ExtensionContext;
  function piFor(name: string): ExtensionAPI {
    const sourceInfo = { path: name, source: name, scope: "temporary", origin: "top-level" };
    return {
      on(event: string, callback: (event: any, ctx: any) => any) {
        let set = handlers.get(event); if (!set) { set = new Set(); handlers.set(event, set); } set.add(callback);
        return () => set!.delete(callback);
      },
      registerCommand(name: string, definition: any) {
        let invocation = name, i = 0; while (commands.has(invocation)) invocation = `${name}:${++i}`;
        commands.set(invocation, { definition, sourceInfo });
      },
      getCommands: () => [...commands].map(([name, entry]) => ({ name, description: entry.definition.description, sourceInfo: entry.sourceInfo, source: "extension" })),
      sendMessage(message: any, options: any) {
        sends.push({ message, options });
        if (options.triggerTurn) return;
        if (busy) queue.push(message); else manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      },
      appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); },
    } as unknown as ExtensionAPI;
  }
  async function emit(name: string, event: any = {}) {
    let current = event;
    const results: any[] = [];
    for (const callback of [...(handlers.get(name) ?? [])]) {
      const result = await callback({ type: name, ...current }, ctx); results.push(result);
      if (result?.messages) current = { ...current, messages: result.messages };
    }
    return { event: current, results };
  }
  function flush() {
    while (queue.length) { const message = queue.shift()!; manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); }
  }
  function messages(): any[] {
    return manager.getBranch().flatMap<any>(entry => entry.type === "message" ? [entry.message] : entry.type === "custom_message" ? [{ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) }] : []);
  }
  function producer(id: ProducerId, overrides: Partial<ProducerRegistration> = {}) {
    const pi = piFor(id), binding = bindMailbox(pi, { agentDir });
    const endpoint = binding.registerProducer({
      id, checkCurrent: () => ({ kind: "allow", project: true, wake: true }),
      proveNative: (mail, branch) => ({ kind: "observed", entries: mail.messages.flatMap((message, messageIndex) => {
        const matches = branch.filter(entry => entry.type === "custom_message" && entry.customType === message.customType && JSON.stringify(entry.content) === JSON.stringify(message.content) && JSON.stringify(entry.details) === JSON.stringify(message.details));
        if (matches.length > 1) throw new Error("duplicate fixture native carrier");
        return matches[0] ? [{ messageIndex, entryId: matches[0].id }] : [];
      }) }), ...overrides,
    });
    return { pi, binding, endpoint };
  }
  function mail(id: ProducerId, key: string, extra: Partial<Mail> = {}): Mail {
    return { producer: id, key, anchorEntryId: manager.getLeafId(), policy: "next-request", wake: true,
      messages: [{ customType: "fixture-body", content: `mail:${key}`, display: false, details: { key } }], ...extra };
  }
  async function startUser() {
    await emit("input", { source: "rpc", text: "user" }); busy = true;
    await emit("before_agent_start", { messageType: "user", prompt: "user", systemPrompt: "", systemPromptOptions: {} }); flush();
  }
  async function context() {
    flush(); const projected = await emit("context", { messages: messages() });
    await emit("context_with_system", { messages: projected.event.messages }); return projected.event.messages;
  }
  async function finish() {
    const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "DONE" }], api: "anthropic-messages" as const, provider: "fixture", model: "faux", stopReason: "stop" as const, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const messageEntryId = manager.appendMessage(message);
    await emit("turn_end", { message, messageEntryId, outcome: "completed", entries: [], continue: false, context: {}, toolResults: [], toolResultEntryIds: [], turnIndex: 0 });
    flush(); await emit("agent_end", { messages: messages() }); busy = false;
    await emit("agent_settled", { aborted: false });
    return messageEntryId;
  }
  return { directory, agentDir, cwd, manager, ctx, handlers, commands, sends, notices, piFor, producer, mail, emit, flush, messages, startUser, context, finish,
    setBusy: (value: boolean) => { busy = value; },
    cleanup: async () => { await clearMailboxes(); if (!options.directory) await rm(directory, { recursive: true, force: true }); } };
}
