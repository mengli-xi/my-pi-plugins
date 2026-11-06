import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
import type { DeliverySlot } from "./engine.js";
import { SlotState, diagnostic, type Registration } from "./slot-state.js";
import { loadEngine, loadedEngine, checkEngineHolder } from "./engine-loader.js";
import { MailboxError } from "./errors.js";
import { getOrCreateRegistry } from "./registry.js";
import { canonicalAgentDir, snapshotPath } from "./paths.js";
import { cloneJson, same, recordKey } from "./json.js";
import {
  MAILBOX_ABI_VERSION,
  MAILBOX_HOLDER_KEY,
  MAILBOX_TRANSPORT_BUILD_ID,
  MAILBOX_PRODUCER_IDS,
  MAILBOX_COMMANDS,
  MAILBOX_COMMAND_DESCRIPTION,
} from "./constants.js";
function identity(ctx: ExtensionContext): MailboxSessionIdentity {
  return { id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() ?? null, cwd: ctx.cwd };
}
export interface Slot extends DeliverySlot {}
export class Slot extends SlotState {
  loading: Promise<void> | null = null;
  constructor(hub: Hub, agentDir: string, ctx: ExtensionContext, previous?: Pick<Slot, "liveAccepted" | "recoveryReleased">) {
    super(hub, agentDir, ctx, previous);
    if (existsSync(dirname(snapshotPath(agentDir, this.session.id)))) this.ready = this.ensureEngine();
  }
  ensureEngine(): Promise<void> {
    if (!this.loading) {
      const loading = loadEngine()
        .then((engine) => engine.attachSlot(this))
        .catch((error) => {
          if (this.loading === loading) this.loading = null;
          throw error;
        });
      this.loading = loading;
      this.ready = loading;
    }
    return this.loading;
  }
  reopen(): Promise<void> {
    if (this.loading) {
      this.store = this.newStorage();
      this.loading = this.store.acquire().then(() => this.rebuild());
      return this.loading;
    }
    return existsSync(dirname(snapshotPath(this.agentDir, this.session.id))) ? this.ensureEngine() : Promise.resolve();
  }
  schedule(): void {}
  scheduleNotices(): void {}
  controlStarted(_value: unknown, _boundary: "message_start" | "message_end"): void {}
  async block(error: unknown): Promise<void> {
    diagnostic(this.owner?.ctx ?? null, error);
  }
  elect(): void {
    const next = this.registrations.find(
      (registration) => !registration.closed && registration.binding.current === this && registration.binding.ctx,
    );
    if (this.owner?.producerToken === next?.token && this.owner) return;
    for (const dispose of this.owner?.hookDisposers ?? []) dispose();
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = null;
    this.ownerEpoch += 1;
    this.owner = null;
    if (!next || this.retired) {
      this.hub.invalidateRecovery(this.agentDir);
      return;
    }
    const pi = next.binding.pi,
      ctx = next.binding.ctx!,
      epoch = this.ownerEpoch;
    const disposers: (() => void)[] = [];
    this.owner = { producerToken: next.token, epoch, pi, ctx, hookDisposers: disposers };
    const hook = async <T>(run: () => Promise<T>, onError?: () => T): Promise<T | undefined> => {
      if (!this.current(next, epoch)) return onError?.();
      this.critical++;
      try {
        await this.ensureEngine();
        return await run();
      } catch (error) {
        try { return onError?.(); }
        finally { await this.block(error); }
      } finally {
        this.critical--;
        this.scheduleNotices();
        if (!this.critical && this.scheduleRequested) this.schedule();
      }
    };
    disposers.push(
      pi.on("input", (event) => {
        if (!this.current(next, epoch) || event.streamingBehavior !== undefined) return;
        this.inputCandidate =
          this.inputCandidate === "empty"
            ? event.source === "interactive" || event.source === "rpc"
              ? "external"
              : "extension"
            : "ambiguous";
      }),
    );
    disposers.push(
      pi.on("before_agent_start", (event, eventCtx) =>
        hook(async () => {
          this.updateContext(eventCtx);
          await this.beforeRun(event);
        }),
      ),
    );
    disposers.push(
      pi.on("context", (event, eventCtx) => {
        const signal = eventCtx.signal;
        return hook(async () => {
          this.updateContext(eventCtx);
          return { messages: await this.project(event) };
        }, () => {
          // Pi 1.5 reports context-hook errors and keeps the old messages. Abort this
          // operation explicitly; also clear the visible list if abort itself fails.
          // A later run has a different signal and must not be aborted by this callback.
          event.messages.length = 0;
          if (eventCtx.signal === signal) eventCtx.abort();
          return { messages: [] };
        });
      }),
    );
    disposers.push(
      pi.on("context_with_system", (event) =>
        hook(async () => {
          await this.observe(event);
        }),
      ),
    );
    disposers.push(
      pi.on("message_start", (event) => {
        this.controlStarted(event.message, "message_start");
      }),
    );
    disposers.push(
      pi.on("message_end", (event) => {
        this.controlStarted(event.message, "message_end");
      }),
    );
    disposers.push(
      pi.on("turn_end", (event) =>
        hook(async () => {
          await this.fulfill(event);
          // A public tool-result/continue boundary already permits a natural next
          // request. Append bodies now; before-settle repairs the wake if none ran.
          await this.drain("active", event.toolResults.length > 0 || event.continue);
        }),
      ),
    );
    disposers.push(
      pi.on("agent_before_settle", () =>
        hook(async () => {
          await this.reconcileProofs();
          await this.drain("active");
        }),
      ),
    );
    disposers.push(
      pi.on("agent_end", (event) =>
        hook(async () => {
          await this.afterRun(event);
        }),
      ),
    );
    disposers.push(
      pi.on("agent_settled", (event, eventCtx) =>
        hook(async () => {
          this.updateContext(eventCtx);
          await this.settled(event);
        }),
      ),
    );
    const beforeNavigation = () => hook(async () => await this.beforeNavigation());
    disposers.push(pi.on("session_before_tree", () => hook(async () => await this.beforeNavigation(true))));
    disposers.push(pi.on("session_before_switch", beforeNavigation));
    disposers.push(pi.on("session_before_fork", beforeNavigation));
    disposers.push(
      pi.on("session_tree", () =>
        hook(async () => {
          // One core owner, one real tree boundary. Unaccepted async producer work
          // captured on a shared ancestor must not silently rehome to its sibling.
          this.bindingGeneration++;
          this.inputCandidate = "empty";
          this.acceptedUser = false;
          await this.rebuild();
          this.schedule();
        }),
      ),
    );
    disposers.push(
      pi.on("session_before_compact", () => {
        this.compacting = true;
      }),
    );
    disposers.push(
      pi.on("session_compact", () => {
        this.compacting = false;
        this.schedule();
      }),
    );
    disposers.push(
      pi.on("session_compact_failed", () => {
        this.compacting = false;
        this.schedule();
      }),
    );
    this.schedule();
    this.scheduleNotices();
  }
  retire(): Promise<void> {
    if (this.retiring) return this.retiring;
    this.retired = true;
    this.registrations.length = 0; // never retain retired Pi/context closures in the process holder
    this.noticeFlights.clear(); // late source work may finish, but cannot ACK a new binding
    this.proofFlights.clear();
    for (const dispose of this.owner?.hookDisposers ?? []) dispose();
    this.owner = null;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = null;
    if (this.noticesScheduled) clearImmediate(this.noticesScheduled);
    this.noticesScheduled = null;
    this.retiring = (async () => {
      await Promise.allSettled([...this.incoming.values()]);
      this.incoming.clear();
      this.admissionAnchors.clear();
      await this.terminalTail;
      await this.ready.catch(() => {});
      await this.store?.close();
      loadedEngine()?.releaseDiskSession(this.session);
    })();
    return this.retiring;
  }
}
export class Binding implements MailboxBinding {
  readonly pi: ExtensionAPI;
  readonly hub: Hub;
  readonly agentDir: string;
  readonly registrations: Registration[] = [];
  readonly disposers: (() => void)[] = [];
  current: Slot | null = null;
  ctx: ExtensionContext | null = null;
  closed = false;
  constructor(hub: Hub, pi: ExtensionAPI, options: BindMailboxOptions) {
    this.hub = hub;
    this.pi = pi;
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.disposers.push(pi.on("session_start", (event, ctx) => this.start(event, ctx)));
    this.disposers.push(
      pi.on("session_shutdown", async () => {
        const slot = this.current;
        if (slot) await slot.retire();
        this.current = null;
        this.ctx = null;
      }),
    );
  }
  async start(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    if (this.closed) return;
    const agentDir = await canonicalAgentDir(this.agentDir),
      session = identity(ctx),
      key = JSON.stringify([agentDir, session.id]);
    this.hub.installFacade(this.pi, ctx, agentDir);
    const fileIdentity = (file: string) => (existsSync(file) ? realpathSync(file) : resolve(file));
    const currentFile = session.file;
    if (
      currentFile &&
      [...this.hub.slots.values()].some(
        (candidate) =>
          !candidate.retired &&
          candidate.session.file &&
          candidate.sessionManager !== ctx.sessionManager &&
          fileIdentity(candidate.session.file) === fileIdentity(currentFile),
      )
    ) {
      throw new MailboxError("writer-conflict", "another live SDK session owns this session file, including across agent directories");
    }
    let slot = this.hub.slots.get(key);
    if (slot && slot.session.file !== session.file) throw new MailboxError("writer-conflict", "mailbox session file identity changed");
    if (slot?.retired && slot.sessionManager !== ctx.sessionManager) {
      // The old execution was shut down and its writer drained. A newly opened
      // SDK session owns no old native queues; reconcile only persisted facts.
      const previous = slot;
      await previous.retiring;
      const joined = this.hub.slots.get(key);
      if (joined && joined !== previous) {
        if (joined.sessionManager !== ctx.sessionManager || joined.session.file !== session.file)
          throw new MailboxError("writer-conflict", "another SDK execution reopened this retired mailbox first");
        slot = joined;
      } else {
        slot = new Slot(this.hub, agentDir, ctx, { liveAccepted: previous.liveAccepted, recoveryReleased: previous.recoveryReleased });
        slot.bindingGeneration = previous.bindingGeneration + 1;
        slot.ownerEpoch = previous.ownerEpoch;
        slot.restoredFromDisk = true;
        this.hub.slots.set(key, slot);
      }
    } else if (slot && slot.sessionManager !== ctx.sessionManager)
      throw new MailboxError("writer-conflict", "another live SDK session identity already owns this mailbox file");
    if (!slot) {
      slot = new Slot(this.hub, agentDir, ctx);
      slot.restoredFromDisk = existsSync(dirname(snapshotPath(agentDir, session.id)));
      this.hub.slots.set(key, slot);
    } else if (slot.retired) {
      await slot.retiring;

      slot.bindingGeneration++;
      slot.retired = false;
      slot.retiring = null;
      slot.ready = slot.reopen();
    }
    this.current = slot;
    this.ctx = ctx;
    for (const registration of this.registrations)
      if (!registration.closed && !slot.registrations.includes(registration)) slot.registrations.push(registration);
    await slot.ready;
    slot.elect();
    slot.scheduleNotices();
    this.hub.invalidateRecovery(agentDir);
  }
  target(registration: Registration, ctx?: ExtensionContext): MailboxTarget {
    const slot = this.current;
    if (!slot || registration.closed || !slot.current(registration))
      throw new MailboxError("not-ready", "mailbox producer has no active session_start binding");
    if (ctx && (ctx.sessionManager !== slot.sessionManager || ctx.sessionManager.getSessionId() !== slot.session.id))
      throw new MailboxError("stale-binding", "mailbox context no longer owns this session");
    return { slotKey: slot.key, session: slot.session, bindingGeneration: slot.bindingGeneration, producerToken: registration.token };
  }
  registerProducer(callbacks: ProducerRegistration): ProducerEndpoint {
    if (
      this.closed ||
      !MAILBOX_PRODUCER_IDS.includes(callbacks.id) ||
      typeof callbacks.checkCurrent !== "function" ||
      typeof callbacks.proveNative !== "function"
    )
      throw new MailboxError("conflict", "invalid mailbox producer registration");
    const registration: Registration = { callbacks, token: Symbol(randomUUID()), binding: this, closed: false };
    this.registrations.push(registration);
    if (this.current) {
      this.current.registrations.push(registration);
      this.current.elect();
      this.current.scheduleNotices();
    }
    const getSlot = (target?: MailboxTarget) => {
      const captured = target ?? this.target(registration);
      const slot = this.hub.slots.get(captured.slotKey);
      if (!slot) throw new MailboxError("stale-binding", "mailbox target slot disappeared");
      slot.assertTarget(registration, captured);
      return { slot, target: captured };
    };
    return {
      id: callbacks.id,
      token: registration.token,
      target: (ctx) => this.target(registration, ctx),
      activateNewExecution: async (target) => {
        const { slot } = getSlot(target);
        await slot.ensureEngine();
        slot.assertTarget(registration, target);
        if (callbacks.id !== "pi-subagents" || slot.restoredFromDisk || slot.recoveryHeld || slot.runOrdinal > 0) {
          const error = new MailboxError(
            "conflict",
            "new execution activation requires pi-subagents owner, no restored mailbox, and no previous run",
          );
          diagnostic(this.ctx, error);
          throw error;
        }
        slot.recoveryHeldKeys.clear();
      },
      put: (mail, target, options) => {
        try {
          if (options !== undefined && !same(cloneJson(options), { recovered: true }))
            throw new MailboxError("conflict", "mailbox recovery admission requires {recovered:true}");
          const value = cloneJson(mail),
            captured = getSlot(target),
            seq = ++captured.slot.ingress;
          if (value.producer !== callbacks.id) throw new MailboxError("conflict", "mailbox endpoint producer mismatch");
          const result = captured.slot
            .ensureEngine()
            .then(() => captured.slot.put(registration, value, captured.target, seq, options !== undefined))
            .then(
              (result) => {
                captured.slot.failedIngress.delete(recordKey(value));
                captured.slot.sourceErrors.delete(recordKey(value));
                return result;
              },
              (error) => {
                if ((error as { code?: unknown } | null)?.code === "io-error") {
                  captured.slot.failedIngress.add(recordKey(value));
                  captured.slot.sourceErrors.set(recordKey(value), String(error));
                }
                throw error;
              },
            );
          captured.slot.incoming.set(seq, result);
          void result.finally(() => captured.slot.incoming.delete(seq)).catch(() => {});
          return result;
        } catch (error) {
          return Promise.reject(error);
        }
      },
      cancel: (key, reason, target) => {
        try {
          const captured = getSlot(target);
          return captured.slot.ensureEngine().then(() => captured.slot.cancel(registration, key, reason, captured.target));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      importFulfilled: (mail, proof, target) => {
        try {
          const value = cloneJson(mail),
            captured = getSlot(target);
          const originalProof = cloneJson(proof);
          return captured.slot
            .ensureEngine()
            .then(() => captured.slot.importFulfilled(registration, value, originalProof, captured.target));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      close: () => {
        if (registration.closed) return;
        registration.closed = true;
        if (this.current) {
          const index = this.current.registrations.indexOf(registration);
          if (index >= 0) this.current.registrations.splice(index, 1);
        }
        this.current?.elect();
      },
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const registration of this.registrations) registration.closed = true;
    if (this.current)
      for (let index = this.current.registrations.length - 1; index >= 0; index--) {
        if (this.current.registrations[index]!.binding === this) this.current.registrations.splice(index, 1);
      }
    this.current?.elect();
    for (const dispose of this.disposers) dispose();
    this.current = null;
    this.ctx = null;
  }
}
export interface Registrar {
  sourceInfo: object;
  description: string;
  scope: { agentDir: string; slotKey: string };
  facade: MailboxCommandFacade | null;
}
export class Hub implements MailboxHolder {
  readonly version = MAILBOX_ABI_VERSION;
  readonly transportBuildId = MAILBOX_TRANSPORT_BUILD_ID;
  readonly slots = new Map<string, Slot>();
  readonly registrars = new Map<object, Registrar>();
  readonly recovery = new Map<string, readonly MailboxRecoveryTarget[] | null>();
  readonly recoveryFlights = new Map<string, Promise<void>>();
  readonly recoveryVersions = new Map<string, number>();
  readonly bind = (pi: ExtensionAPI, options: BindMailboxOptions = {}): MailboxBinding => new Binding(this, pi, options);
  invalidateRecovery(agentDir: string): void {
    this.recovery.delete(agentDir);
    this.recoveryVersions.set(agentDir, (this.recoveryVersions.get(agentDir) ?? 0) + 1);
  }
  refreshRecovery(agentDir: string): Promise<void> {
    return loadEngine().then((engine) => engine.refreshRecovery(this, agentDir));
  }
  recover(target: MailboxRecoveryTarget, ctx: ExtensionCommandContext): Promise<void> {
    return loadEngine().then((engine) => engine.recover(this, target, ctx));
  }
  private async commandFacade(registrar: Registrar): Promise<MailboxCommandFacade> {
    const engine = await loadEngine();
    const slot = this.slots.get(registrar.scope.slotKey);
    if (slot) await slot.ensureEngine();
    return (registrar.facade ??= engine.commandFacade(this, registrar));
  }
  installFacade(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string): void {
    const key = JSON.stringify([agentDir, ctx.sessionManager.getSessionId()]);
    const inventory = pi.getCommands().filter((command) => command.name === "mailbox" || command.name.startsWith("mailbox:"));
    if (inventory.length) {
      const command = inventory[0]!,
        registrar = this.registrars.get(command.sourceInfo);
      if (inventory.length !== 1 || command.name !== "mailbox" || !registrar || command.description !== registrar.description)
        throw new MailboxError("command-collision", "unknown mailbox command or mailbox:n collision; refusing delivery");
      registrar.scope = { agentDir, slotKey: key };
      return;
    }
    const registrar: Registrar = {
      sourceInfo: {},
      description: MAILBOX_COMMAND_DESCRIPTION,
      facade: null,
      scope: { agentDir, slotKey: key },
    };

    const facade = {
      description: MAILBOX_COMMAND_DESCRIPTION,
      getArgumentCompletions: (prefix: string) => {
        const input = prefix.trimStart();
        if (!input.startsWith("recover ")) {
          const matches = MAILBOX_COMMANDS.filter((command) => command.startsWith(input)).map((command) => ({
            value: command,
            label: command,
          }));
          return matches.length ? matches : null;
        }
        if (!this.slots.get(registrar.scope.slotKey)?.current()) return null;
        const engine = loadedEngine();
        if (engine) {
          registrar.facade ??= engine.commandFacade(this, registrar);
          return registrar.facade.getArgumentCompletions(prefix);
        }
        void this.commandFacade(registrar).catch((error) => diagnostic(null, error));
        return null;
      },
      handler: async (args: string, commandCtx: ExtensionCommandContext) => {
        try {
          const route = await this.commandFacade(registrar);
          if (args.trim().startsWith("recover ")) await this.refreshRecovery(registrar.scope.agentDir);
          await route.handler(args, commandCtx);
        } catch (error) {
          commandCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    };
    // Inventory/provenance registration remains one synchronous span before any engine load.
    pi.registerCommand("mailbox", { ...facade, getArgumentCompletions: facade.getArgumentCompletions });
    const registered = pi.getCommands().filter((command) => command.name === "mailbox" || command.name.startsWith("mailbox:"));
    if (registered.length !== 1 || registered[0]!.name !== "mailbox")
      throw new MailboxError("command-collision", "mailbox facade registration collided");
    registrar.sourceInfo = registered[0]!.sourceInfo;
    registrar.description = facade.description;
    this.registrars.set(registrar.sourceInfo, registrar);
    // This runner-scoped bridge is intentionally NOT in delivery owner disposers.
    pi.on("session_start", (_event, nextCtx) => {
      registrar.scope = { agentDir, slotKey: JSON.stringify([agentDir, nextCtx.sessionManager.getSessionId()]) };
    });
    pi.on("session_shutdown", async (_event, shutdownCtx) => {
      const slot = this.slots.get(JSON.stringify([agentDir, shutdownCtx.sessionManager.getSessionId()]));
      if (slot?.sessionManager === shutdownCtx.sessionManager) await slot.retire();
    });
  }
}
export function bindMailbox(pi: ExtensionAPI, options?: BindMailboxOptions): MailboxBinding {
  checkEngineHolder();
  const symbol = Symbol.for(MAILBOX_HOLDER_KEY);
  const holder = getOrCreateRegistry(symbol, () => new Hub()) as MailboxHolder;
  if (
    !holder ||
    holder.version !== MAILBOX_ABI_VERSION ||
    holder.transportBuildId !== MAILBOX_TRANSPORT_BUILD_ID ||
    !(holder.slots instanceof Map) ||
    typeof holder.bind !== "function"
  )
    throw new MailboxError("holder-incompatible", "mailbox holder ABI/build/method mismatch; no private delivery fallback");
  return holder.bind(pi, options);
}
