import type { ExtensionAPI, ExtensionContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import type { TextOpener } from "./openers.ts";
import type { TUI } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ExtensionRunner, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { chatChildren, interactiveUserMessagePrototype, TIMESTAMP_BINDING_PROBE, type TimestampOwner } from "./compat/user-message.ts";
import { declareProbes, markBroken, markOk } from "./internals.ts";

type Method = (this: object, ...args: any[]) => any;
type Kind = "component" | "mode" | "assistant" | "runner";
interface Patch {
  original?: PropertyDescriptor;
  dispatcher: Method;
  methods: Map<Owner, Method>;
  restore(): void;
}
interface Owner {
  live: boolean;
  openText?: TextOpener;
  tui?: TUI;
  locals: Map<object, object>;
  patches: Set<Patch>;
  sessionId?: string;
  modeMatches?: (receiver: object) => boolean;
}
interface Registry {
  apis: WeakMap<ExtensionAPI, Owner>;
  receivers: WeakMap<object, Owner>;
  messages: WeakMap<object, Owner>;
  owners: Set<Owner>;
  patches: WeakMap<object, Map<PropertyKey, Patch>>;
  requests?: WeakMap<object, Owner>;
  sessions?: Map<string, Owner>;
  transformerLookup?: ExtensionRunner["getMarkdownTransformers"];
  current?: Owner;
}
// Internal CC ownership, shared by the source and bundled child module graphs.
const KEY = Symbol.for("pi.claude-style.presentation-owners.v1");
function registry(): Registry {
  const globals = globalThis as Record<PropertyKey, unknown>;
  return (globals[KEY] ??= {
    apis: new WeakMap(), receivers: new WeakMap(), messages: new WeakMap(),
    owners: new Set(), patches: new WeakMap(),
  }) as Registry;
}

function visit(root: unknown, receiver: object, children: unknown, owner: Owner, seen = new Set<object>()): boolean {
  if (!root || typeof root !== "object" || seen.has(root)) return false;
  seen.add(root);
  registry().receivers.set(root, owner);
  let found = root === receiver;
  // Container.children is public. Transparent wrappers participate structurally.
  const nested = (root as { children?: unknown }).children;
  if (!Array.isArray(nested)) return found;
  registry().receivers.set(nested, owner);
  found ||= nested === children;
  // Index the entire public tree on a cache miss: historical user rows then
  // resolve in O(1), rather than each scanning the same history again.
  for (const child of nested) found = visit(child, receiver, children, owner, seen) || found;
  return found;
}

function resolve(receiver: object, args: any[], kind: Kind): Owner | undefined {
  const shared = registry();
  const known = shared.receivers.get(receiver);
  if (known?.live) return known;
  if (kind === "runner") {
    try {
      const runner = receiver as ExtensionRunner;
      const sessionId = runner.createContext().sessionManager.getSessionId();
      const knownSession = shared.sessions?.get(sessionId);
      if (knownSession?.live) return knownSession;
      // Reload restores history before session_start. Identify this runner by
      // our own publicly registered callback, never by Pi's private fields.
      for (const transform of shared.transformerLookup?.call(runner) ?? []) {
        const registered = shared.receivers.get(transform);
        if (!registered?.live) continue;
        registered.sessionId = sessionId;
        (shared.sessions ??= new Map()).set(sessionId, registered);
        return registered;
      }
      return undefined;
    } catch { return undefined; }
  }
  const message = kind === "assistant" ? args[0] : undefined;
  let owner = message && typeof message === "object" ? shared.messages.get(message) : undefined;
  if (!owner?.live) {
    // user-message.timestampBinding already owns this private seam; no new
    // InteractiveMode field is read here.
    const children = kind === "mode" ? chatChildren(receiver) : undefined;
    owner = [...shared.owners].find((candidate) => candidate.live && candidate.tui
      && visit(candidate.tui, receiver, children, candidate));
  }
  if (!owner && kind === "mode") {
    // Reload paints history before session_start mounts extension widgets.
    // Features with an audited mode/runner seam can identify that receiver by
    // the owned public Markdown transformer already registered on its runner.
    owner = [...shared.owners].find(candidate => {
      try { return candidate.live && candidate.modeMatches?.(receiver); } catch { return false; }
    });
  }
  owner ??= shared.current;
  if (owner?.live) shared.receivers.set(receiver, owner);
  return owner?.live ? owner : undefined;
}

export function installPresentationOwner(pi: ExtensionAPI): void {
  const shared = registry();
  let owner = shared.apis.get(pi);
  if (owner) return;
  owner = { live: true, locals: new Map(), patches: new Set() };
  shared.apis.set(pi, owner);
  shared.owners.add(owner);
  shared.transformerLookup ??= ExtensionRunner.prototype.getMarkdownTransformers;
  const installed = owner;
  // Idle sendMessage() reaches the session subscriber without an extension
  // message_start event. Its component is constructed before it joins the TUI.
  // Keep this already-audited seam independent of user-message styling.
  declareProbes([TIMESTAMP_BINDING_PROBE]);
  const mode = presentationPrototype(pi, interactiveUserMessagePrototype<TimestampOwner>(), "mode");
  const append = mode.addMessageToChat;
  if (typeof append === "function") mode.addMessageToChat = function (message, options) {
    shared.messages.set(message, installed);
    markOk(TIMESTAMP_BINDING_PROBE.id);
    return append.call(this, message, options);
  };
  else markBroken(TIMESTAMP_BINDING_PROBE.id, "addMessageToChat 不可用，未传播消息归属");

  // Public component operations form a scope for deferred CC Markdown. Custom
  // message and entry renderers are scoped by their own facade (ownedCustom).
  // No traversal through private/opaque wrapper fields.
  for (const [prototype, kind] of [
    [AssistantMessageComponent.prototype, "assistant"],
    [ToolExecutionComponent.prototype, "component"],
  ] as const) {
    const scoped = presentationPrototype(pi, prototype, kind);
    const render = scoped.render;
    const invalidate = scoped.invalidate;
    scoped.render = function (width) {
      return render.call(this, width);
    };
    scoped.invalidate = function () {
      invalidate.call(this);
    };
  }
  const runner = presentationPrototype(pi, ExtensionRunner.prototype, "runner");
  const entryRenderer = runner.getEntryRenderer;
  runner.getEntryRenderer = function (name) {
    const render = entryRenderer.call(this, name);
    return render && (function (this: unknown, ...args) { return inOwner(installed, () => {
      const component = render.apply(this, args);
      if (!component || !installed.live) return component;
      try { return ownedCustom(installed, component); }
      catch { return component; }
    }); });
  };
  const messageRenderer = runner.getMessageRenderer;
  runner.getMessageRenderer = function (name) {
    const render = messageRenderer.call(this, name);
    return render && (function (this: unknown, ...args) { return inOwner(installed, () => {
      const component = render.apply(this, args);
      if (!component || !installed.live) return component;
      try { return ownedCustom(installed, component); }
      catch { return component; }
    }); });
  };
  const resolveTools = runner.resolveToolRenderers;
  const toolCache = new WeakMap<object, ReturnType<ExtensionRunner["resolveToolRenderers"]>>();
  runner.resolveToolRenderers = function (...args) {
    const renderers = resolveTools.apply(this, args);
    if (!renderers) return renderers;
    const cached = toolCache.get(renderers);
    if (cached) return cached;
    // Copy descriptors, including CC's non-enumerable image policy. Components
    // remain untouched, so ToolRenderContext.lastComponent retains its identity.
    try {
      const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(renderers);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key]!;
        if (descriptor.get || descriptor.set) descriptors[key] = {
          configurable: true, enumerable: descriptor.enumerable,
          get: () => Reflect.get(renderers, key, renderers),
        };
      }
      for (const key of ["renderCall", "renderResult"] as const) {
        const render = renderers[key];
        if (render) descriptors[key] = { configurable: true, enumerable: true, writable: true,
          value: (...params: any[]) => inOwner(installed, () => (render as Method).apply(renderers, params)),
        };
      }
      const scoped = Object.create(Object.getPrototypeOf(renderers), descriptors) as typeof renderers;
      toolCache.set(renderers, scoped);
      return scoped;
    } catch { return renderers; }
  };
  const transformers = runner.getMarkdownTransformers;
  runner.getMarkdownTransformers = function () {
    return transformers.call(this).map((transform) => (...args) => inOwner(installed, () => transform(...args)));
  };
  const capture = (ctx: ExtensionContext) => {
    const sessions = shared.sessions ??= new Map();
    if (installed.sessionId && sessions.get(installed.sessionId) === installed) sessions.delete(installed.sessionId);
    installed.sessionId = ctx.sessionManager.getSessionId?.();
    if (installed.sessionId) sessions.set(installed.sessionId, installed);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message") shared.messages.set(entry.message, installed);
    }
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("pi-claude-style:owner", (tui) => {
      installed.tui = tui;
      return { render: () => [], invalidate() {} };
    });
  };
  pi.on("session_start", (_event, ctx) => capture(ctx));
  pi.on("message_start", (event) => { shared.messages.set(event.message, installed); });
  pi.on("message_update", (event) => { shared.messages.set(event.message, installed); });
  pi.on("session_shutdown", () => disposePresentationOwner(pi));
}

/** Release only this presentation; other sessions retain the shared dispatcher. */
export function disposePresentationOwner(pi: ExtensionAPI): void {
  const shared = registry();
  const owner = shared.apis.get(pi);
  if (!owner) return;
  owner.live = false;
  owner.tui = undefined;
  owner.openText = undefined;
  if (owner.sessionId && shared.sessions?.get(owner.sessionId) === owner) shared.sessions.delete(owner.sessionId);
  shared.owners.delete(owner);
  for (const patch of owner.patches) {
    patch.methods.delete(owner);
    if (patch.methods.size === 0) patch.restore();
  }
  owner.patches.clear();
  owner.locals.clear();
}

function inOwner<T>(owner: Owner, action: () => T): T {
  const shared = registry();
  const previous = shared.current;
  shared.current = owner.live ? owner : undefined;
  try { return action(); }
  finally { shared.current = previous; }
}

/** Scope operations without adding Container's keyboard/focus/layout semantics. */
function ownedCustom(owner: Owner, component: Component): Component {
  const source = component;
  const methods = new Map<PropertyKey, { original: Function; scoped: Method }>();
  const target = Object.create(null) as Component;
  const scopedFunctions = new WeakSet<Function>();
  const slotMethods = new WeakMap<Function, Method>();
  const slotGetters = new WeakMap<Function, () => unknown>();
  const slotSetters = new WeakMap<Function, (value: unknown) => void>();
  let facade: Component;
  const readSource = (key: PropertyKey) => inOwner(owner, () => {
    const original = Reflect.get(source, key, source);
    if (typeof original !== "function" || key === "constructor") return original;
    let cached = methods.get(key);
    if (cached?.original !== original) {
      cached = { original, scoped: function (...args) { return inOwner(owner, () => original.apply(source, args)); } };
      scopedFunctions.add(cached.scoped);
      methods.set(key, cached);
    }
    return cached!.scoped;
  });
  const scopeSlotMethod = (value: unknown) => {
    if (typeof value !== "function" || scopedFunctions.has(value)) return value;
    let scoped = slotMethods.get(value);
    if (!scoped) {
      scoped = function (...args) { return inOwner(owner, () => value.apply(facade, args)); };
      slotMethods.set(value, scoped); scopedFunctions.add(scoped);
    }
    return scoped;
  };
  const defineRender = (descriptor: PropertyDescriptor) => {
    if ("value" in descriptor) return Reflect.defineProperty(target, "render", { ...descriptor, value: scopeSlotMethod(descriptor.value) });
    const local = { ...descriptor };
    if (descriptor.get) {
      let get = slotGetters.get(descriptor.get);
      if (!get) {
        const original = descriptor.get;
        get = () => inOwner(owner, () => scopeSlotMethod(original.call(facade)));
        slotGetters.set(original, get); slotGetters.set(get, get);
      }
      local.get = get;
    }
    if (descriptor.set) {
      let set = slotSetters.get(descriptor.set);
      if (!set) {
        const original = descriptor.set;
        set = (value) => { inOwner(owner, () => original.call(facade, value)); };
        slotSetters.set(original, set); slotSetters.set(set, set);
      }
      local.set = set;
    }
    return Reflect.defineProperty(target, "render", local);
  };
  // Pinned temporarily decorates this required operation. Keep that write on
  // CC's slot, including descriptor restoration, never on a frozen component.
  const setRender = (value: unknown) => {
    return defineRender({ configurable: true, enumerable: true, writable: true, value });
  };
  // This default belongs to CC and reads the source directly, never the local
  // override. Restoring an accessor therefore cannot retain decoration or recur.
  const sourceRenderDescriptor = Reflect.getOwnPropertyDescriptor(source, "render");
  if (sourceRenderDescriptor) defineRender({ configurable: true, enumerable: sourceRenderDescriptor.enumerable,
    get: () => readSource("render"), set: setRender,
  });
  // The proxy target belongs to CC, so frozen/non-configurable source methods
  // need no writes or Proxy invariant exceptions. Only caller-requested members
  // are forwarded; no traversal through opaque component fields is performed.
  facade = new Proxy(target, {
    get: (_target, key) => {
      if (key === "render" && Object.hasOwn(target, key)) return inOwner(owner, () => Reflect.get(target, key, facade));
      return readSource(key);
    },
    has: (_target, key) => key in source || Object.hasOwn(target, key),
    set: (_target, key, value) => key === "render" ? setRender(value) : inOwner(owner, () => Reflect.set(source, key, value, source)),
    defineProperty: (_target, key, descriptor) => key === "render" ? defineRender(descriptor) : Reflect.defineProperty(source, key, descriptor),
    deleteProperty: (_target, key) => Reflect.deleteProperty(key === "render" ? target : source, key),
    getPrototypeOf: () => Reflect.getPrototypeOf(source),
    ownKeys: () => [...new Set([...Reflect.ownKeys(source), ...Reflect.ownKeys(target)])],
    getOwnPropertyDescriptor(_target, key) {
      if (key === "render") return Reflect.getOwnPropertyDescriptor(target, key);
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
      if (!descriptor) return undefined;
      return "value" in descriptor ? { ...descriptor, configurable: true, value: readSource(key) }
        : { ...descriptor, configurable: true,
          get: descriptor.get ? () => readSource(key) : undefined,
          set: descriptor.set ? (value) => { inOwner(owner, () => Reflect.set(source, key, value, source)); } : undefined,
        };
    },
    // Do not let an external seal/freeze invalidate the forwarding proxy traps.
    preventExtensions: () => false,
  });
  return facade;
}

/**
 * Existing installers keep their local closures and cleanup. Only the actual
 * prototype receives a process-wide dispatcher; its WeakMap receiver lookup
 * selects the session's local implementation, including during background output.
 */
export function presentationPrototype<T>(pi: ExtensionAPI | undefined, prototype: T, kind: Kind): T {
  if (!pi) return prototype;
  const shared = registry();
  const owner = shared.apis.get(pi);
  if (!owner) return prototype;
  const actual = prototype as object;
  const cached = owner.locals.get(actual);
  if (cached) return cached as T;
  const local = Object.create(null) as Record<PropertyKey, any>;
  let patches = shared.patches.get(actual);
  if (!patches) shared.patches.set(actual, patches = new Map());
  const allPatches = patches;
  const virtual = new Proxy(local, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      const patch = allPatches.get(key);
      return patch ? patch.original?.value : Reflect.get(actual, key);
    },
    set(target, key, value) {
      target[key] = value;
      if (typeof key === "symbol" || !owner.live) return true;
      let patch = allPatches.get(key);
      if (!patch && typeof value === "function") {
        const original = Object.getOwnPropertyDescriptor(actual, key);
        const fallback = Reflect.get(actual, key) as Method | undefined;
        const methods = new Map<Owner, Method>();
        const dispatcher: Method = function (...args) {
          const selected = resolve(this, args, kind);
          const method = selected && methods.get(selected);
          const previous = shared.current;
          shared.current = method ? selected : undefined;
          try { return (method ?? fallback)?.apply(this, args); }
          finally { shared.current = previous; }
        };
        patch = { original: original ?? (fallback ? { value: fallback } : undefined), dispatcher, methods,
          restore() {
            if (Reflect.get(actual, key) === dispatcher) {
              if (original) Object.defineProperty(actual, key, original);
              else Reflect.deleteProperty(actual, key);
            }
            allPatches.delete(key);
          },
        };
        allPatches.set(key, patch);
        Object.defineProperty(actual, key, { configurable: true, writable: true, value: dispatcher });
      }
      if (patch) {
        if (typeof value === "function") patch.methods.set(owner, value);
        else patch.methods.delete(owner);
        owner.patches.add(patch);
      }
      return true;
    },
    deleteProperty(target, key) {
      delete target[key];
      if (typeof key !== "symbol") allPatches.get(key)?.methods.delete(owner);
      return true;
    },
  });
  owner.locals.set(actual, virtual);
  return virtual as T;
}

/** A shared custom-entry provider routes its click through the rendered instance. */
export function registerPresentationOpener(pi: ExtensionAPI, openText: TextOpener): boolean {
  const owner = registry().apis.get(pi);
  if (!owner) return false;
  owner.openText = openText;
  return true;
}
export function openPresentationText(receiver: object, ...args: Parameters<TextOpener>): boolean {
  return resolve(receiver, [], "component")?.openText?.(...args) ?? false;
}

/** Bind render-time ownership before Pi wraps a custom component in a MouseRegion. */
export function bindPresentationReceiver(receiver: object): void {
  const shared = registry();
  if (shared.current?.live) shared.receivers.set(receiver, shared.current);
}

/** Register an owned callback identity, including before a UI context exists. */
export function ownedMarkdownTransformer(pi: ExtensionAPI, transform: MarkdownTransformer): MarkdownTransformer {
  const owner = registry().apis.get(pi);
  if (!owner) return transform;
  const registered: MarkdownTransformer = (...args) => transform(...args);
  registry().receivers.set(registered, owner);
  return registered;
}

/**
 * A lazy delegate retains its request across render/invalidate/click. Remember
 * that request at our provider boundary so later provider replacement can
 * create a CC component for the same owner without modifying the delegate.
 */
export function withPresentationRequest<T>(request: unknown, render: () => T): T | undefined {
  const shared = registry();
  const requests = shared.requests ??= new WeakMap();
  const key = request !== null && typeof request === "object" ? request : undefined;
  const owner = shared.current?.live ? shared.current : key ? requests.get(key) : undefined;
  // No trustworthy owner: leave the consumer's native fallback available.
  if (!owner?.live) return undefined;
  if (key) requests.set(key, owner);
  const previous = shared.current;
  shared.current = owner;
  try { return render(); }
  finally { shared.current = previous; }
}

/** Inspect the native method beneath CC's own receiver dispatcher for probes. */
export function originalPresentationMethod(prototype: object, key: PropertyKey): unknown {
  const method = Reflect.get(prototype, key);
  const patch = registry().patches.get(prototype)?.get(key);
  return patch && patch.dispatcher === method ? patch.original?.value : method;
}

/** Resolve only after native init has mounted this view's public TUI tree. */
export function presentationReceiverBelongsTo(pi: ExtensionAPI | undefined, receiver: object): boolean {
  return !!pi && registry().apis.get(pi) === resolve(receiver, [], "mode");
}

export function registerPresentationModeResolver(pi: ExtensionAPI, matches: (receiver: object) => boolean): () => void {
  const owner = registry().apis.get(pi);
  if (!owner) return () => {};
  owner.modeMatches = matches;
  return () => { if (owner.modeMatches === matches) owner.modeMatches = undefined; };
}

export function presentationRunnerBelongsTo(pi: ExtensionAPI, receiver: ExtensionRunner): boolean {
  return registry().apis.get(pi) === resolve(receiver, [], "runner");
}
