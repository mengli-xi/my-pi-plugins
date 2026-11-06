import type { InteractiveMode, AgentSessionRuntime, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";
import { getSessionAssemblyPublicModules } from "pi-session-runtime/session-assembly";
import { bindInputPolicy, type InputPolicy } from "pi-session-runtime/input-policy";
import { captureProcessHandlers, releaseChildProcessHandlers } from "pi-session-runtime/process-ownership";
import { deferTerminalFrames, gateTerminal, type TerminalOwner, type TerminalReleaseReason } from "pi-session-runtime/terminal-owner";
import { ViewInitialization } from "#internal/view-initialization";
export type ManagedViewCloseReason = TerminalReleaseReason;

export class ViewLifecycle {
  #attach = new Set<() => void>();
  #detach = new Set<() => void | Promise<void>>();
  onAttach(callback: () => void) { this.#attach.add(callback); return () => { this.#attach.delete(callback); }; }
  onDetach(callback: () => void | Promise<void>) { this.#detach.add(callback); return () => { this.#detach.delete(callback); }; }
  attach() { for (const callback of this.#attach) callback(); }
  async detach() {
    const errors: unknown[] = [];
    for (const callback of [...this.#detach].reverse()) { try { await callback(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Failed to detach child presentation");
  }
}

const blockedActions = {
  newSession: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
  fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }), reload: async () => {},
};
const INITIALIZATION_TIMEOUT_MS = 2_000;

/** Fence native init's public bind continuation without modifying its session. */
function initializationRuntime(runtime: AgentSessionRuntime, initialization: ViewInitialization): AgentSessionRuntime {
  const session = new Proxy(runtime.session, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "bindExtensions") return (...args: Parameters<typeof target.bindExtensions>) => {
      initialization.assertActive();
      return initialization.wait(value.apply(target, args));
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return new Proxy(runtime, { get(target, key) {
    if (key === "session") return session;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** Owns only a disposable native view. The caller keeps ownership of execution and JSONL. */
export class ManagedInteractive {
  readonly lifecycle = new ViewLifecycle();
  /** Optional first-use presentation loader, called before any terminal handoff. */
  prepare?: () => Promise<void>;
  /** Consumer-owned instance adapters, installed before native history is rendered. */
  configureMode?: (mode: InteractiveMode) => () => void;
  /** Consumer notification after native init, theme and draft restoration all succeed. */
  onLoaded?: () => void | Promise<void>;
  draft = "";
  #runtime?: AgentSessionRuntime;
  #mode?: InteractiveMode;
  #owner?: TerminalOwner;
  #policy?: InputPolicy;
  #ui?: ExtensionUIContext;
  #factory?: ReturnType<ExtensionUIContext["getEditorComponent"]>;
  #editor?: EditorComponent;
  #tui?: TUI;
  #headless?: ExtensionUIContext;
  #disposeInput?: () => Promise<void>;
  #stopControls?: () => void;
  #gate?: ReturnType<typeof gateTerminal>;
  #initialFrames?: ReturnType<typeof deferTerminalFrames>;
  #disposeMode?: () => void;
  #yielding?: Promise<unknown>;
  #yieldAbort?: AbortController;
  #initialization?: ViewInitialization;
  #tearingDownTerminal?: (active: boolean) => void;
  #closing?: Promise<void>;
  #resolve?: () => void;
  #closed?: Promise<void>;
  #report: (error: unknown) => void;
  #interrupt: () => Promise<void>;
  #closeReason: ManagedViewCloseReason = "return";
  constructor(report: (error: unknown) => void, interrupt: () => Promise<void>) { this.#report = report; this.#interrupt = interrupt; }
  get attached() { return this.#closed !== undefined; }
  requestReturn = () => { void this.close().catch(this.#report); };

  /** Install after presentation factories so their session_start handlers run first. */
  readonly extension: ExtensionFactory = pi => {
    pi.on("session_before_switch", () => ({ cancel: true }));
    pi.on("session_before_fork", () => ({ cancel: true }));
    pi.on("session_before_tree", () => ({ cancel: true }));
    this.lifecycle.onAttach(() => {
      const initialization = this.#initialization;
      this.#stopControls = pi.on("session_start", (_event, ctx) => {
        if (!initialization || initialization.abort.signal.aborted || this.#initialization !== initialization || ctx.mode !== "tui" || !this.#policy) return;
        this.#ui = ctx.ui;
        const { CustomEditor } = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
        const original = ctx.ui.getEditorComponent() ?? ((tui, theme, keys) => new CustomEditor(tui, theme, keys));
        if (original === this.#factory) return;
        // A transparent public factory proxy preserves the presenter's own marker/state properties.
        this.#factory = new Proxy(original, { apply: (target, receiver, args: Parameters<typeof original>) => {
          initialization.assertActive();
          const editor = Reflect.apply(target, receiver, args) as EditorComponent;
          void this.#disposeInput?.().catch(this.#report); this.#editor = editor; this.#tui = args[0];
          this.#disposeInput = bindInputPolicy(ctx, editor, args[0], args[2], this.#policy!);
          return editor;
        } });
        ctx.ui.setEditorComponent(this.#factory);
      });
    });
    this.lifecycle.onDetach(async () => {
      await this.#disposeInput?.(); this.#disposeInput = undefined;
      this.#stopControls?.(); this.#stopControls = undefined;
    });
  };

  async open(runtime: AgentSessionRuntime, owner: TerminalOwner, policy: InputPolicy): Promise<void> {
    if (this.attached) throw new Error("Child view is already open");
    if (!(runtime.session instanceof getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"].AgentSession)) throw new Error("Managed view requires the same session-assembly SDK realm as its child session");
    this.#runtime = runtime; this.#owner = owner; this.#policy = policy;
    this.#closeReason = "return";
    this.#headless = runtime.session.extensionRunner.getUIContext();
    this.#closed = new Promise(resolve => { this.#resolve = resolve; });
    const closed = this.#closed;
    const initialization = this.#initialization = new ViewInitialization(INITIALIZATION_TIMEOUT_MS, () => {
      this.#initialFrames?.release(!this.#tui);
      this.#tui?.requestRender(true);
      this.#report(new Error(`Managed view initialization exceeded ${INITIALIZATION_TIMEOUT_MS} ms; showing the current view while initialization continues`));
    });
    try { await this.enter(runtime, owner, initialization); }
    catch (error) {
      if (!initialization.abort.signal.aborted) { await this.close(); throw error; }
    }
    await closed;
  }
  private async enter(runtime: AgentSessionRuntime, owner: TerminalOwner, initialization: ViewInitialization) {
    const publicModules = getSessionAssemblyPublicModules();
    const { InteractiveMode: NativeInteractiveMode } = publicModules["@earendil-works/pi-coding-agent"];
    const { ProcessTerminal, isKeyRelease, isKeyRepeat, matchesKey } = publicModules["@earendil-works/pi-tui"];
    await initialization.wait(this.prepare?.());
    await initialization.wait(owner.acquire(initialization.abort.signal));
    this.lifecycle.attach();
    const terminal = new ProcessTerminal();
    let teardown = false, stopped = false;
    this.#tearingDownTerminal = active => { teardown = active; };
    this.#gate = gateTerminal(terminal, () => (!initialization.abort.signal.aborted || teardown) && !owner.isMainForeground);
    const start = terminal.start.bind(terminal), stop = terminal.stop.bind(terminal);
    terminal.start = (input, resize) => {
      initialization.assertActive();
      stopped = false;
      start(data => {
        if (initialization.abort.signal.aborted) return;
        if (!initialization.finished && matchesKey(data, this.#policy!.returnKey as Parameters<typeof matchesKey>[1])) {
          if (!isKeyRelease(data) && !isKeyRepeat(data)) this.requestReturn();
          return;
        }
        input(data);
      }, resize);
    };
    terminal.stop = () => { if (!stopped) { stopped = true; stop(); } };
    // Stock init starts rendering before session_start. Allow terminal/color
    // negotiation, but publish no frame until the presentation is installed.
    this.#initialFrames = deferTerminalFrames(terminal, true);
    if (initialization.expired) this.#initialFrames.release();
    this.#mode = new NativeInteractiveMode(initializationRuntime(runtime, initialization), { terminal, tuiMode: "fullscreen", initialThemeSetting: owner.themeName });
    this.#disposeMode = this.configureMode?.(this.#mode);
    const handlers = captureProcessHandlers();
    await initialization.wait(this.#mode.init());
    releaseChildProcessHandlers(handlers);
    await initialization.wait(runtime.session.bindExtensions({
      shutdownHandler: this.requestReturn,
      abortHandler: () => { void this.#interrupt().catch(this.#report); },
      commandContextActions: { ...blockedActions, waitForIdle: () => runtime.session.waitForIdle() },
      onError: this.#report,
    }));
    const themed = this.#ui?.setTheme(owner.themeName!);
    if (!themed?.success) throw new Error(`Unable to apply Main theme to child view: ${themed?.error ?? "UI unavailable"}`);
    this.#ui?.setEditorText(this.draft);
    await initialization.wait(this.onLoaded?.());
    initialization.complete();
    this.#initialFrames.release();
    this.#tui?.requestRender(true);
  }
  /** Temporarily lend the foreground terminal to an external editor; close cancels and drains it. */
  async yieldTerminal<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.#mode || !this.#ui || !this.#tui || this.#closing || this.#yielding) throw new Error("View terminal is unavailable");
    const mode = this.#mode, ui = this.#ui, tui = this.#tui;
    const abort = this.#yieldAbort = new AbortController();
    const unfence = ui.onTerminalInput(() => ({ consume: true }));
    const operation = (async () => {
      tui.stop({ preserveScreen: true });
      try { return await action(abort.signal); }
      finally {
        if (this.#mode === mode && !this.#closing) { tui.start(); tui.requestRender(true); }
      }
    })();
    this.#yielding = operation;
    try { return await operation; }
    finally { unfence(); this.#yielding = undefined; this.#yieldAbort = undefined; }
  }
  close(reason: ManagedViewCloseReason = "return"): Promise<void> {
    if (!this.#closed) return Promise.resolve();
    // A shutdown can overtake a pending return while admission/init is draining.
    if (reason === "quit") this.#closeReason = reason;
    const initialization = this.#initialization!;
    const abandoned = !initialization.finished;
    initialization.cancel();
    return this.#closing ??= (async () => {
      this.#yieldAbort?.abort();
      await this.#yielding?.catch(() => undefined);
      const runtime = this.#runtime!;
      try {
        await this.lifecycle.detach();
      } finally {
        this.#initialFrames?.dispose(); this.#initialFrames = undefined;
        this.draft = this.#editor?.getExpandedText?.() ?? this.#editor?.getText() ?? this.draft;
        this.#tearingDownTerminal?.(true);
        try { this.#mode?.stop("resume-hint"); }
        finally {
          this.#tearingDownTerminal?.(false); this.#tearingDownTerminal = undefined;
          this.#disposeMode?.(); this.#disposeMode = undefined; this.#mode = undefined;
        }
        // A pending native init can still write to its retired terminal. Keep
        // that terminal's gate closed instead of restoring its raw writer.
        if (!abandoned) this.#gate?.restore();
        this.#gate = undefined;
        runtime.setRebindSession(undefined); runtime.setBeforeSessionInvalidate(undefined);
        try {
          const rebound = runtime.session.bindExtensions({ mode: "print", uiContext: this.#headless,
            commandContextActions: { ...blockedActions, waitForIdle: () => runtime.session.waitForIdle() },
            abortHandler: () => { void this.#interrupt().catch(this.#report); },
            shutdownHandler: this.requestReturn, onError: this.#report });
          if (abandoned) {
            runtime.session.extensionRunner.setUIContext(undefined, "print");
            void rebound.catch(this.#report);
          } else {
            await rebound;
            runtime.session.extensionRunner.setUIContext(undefined, "print");
          }
        } finally {
          try { this.#owner?.restore(this.#closeReason); }
          finally {
            this.#ui = undefined; this.#editor = undefined; this.#tui = undefined; this.#headless = undefined; this.#factory = undefined;
            this.#runtime = undefined; this.#owner = undefined; this.#policy = undefined;
            this.#initialization = undefined;
            this.#resolve?.(); this.#resolve = undefined; this.#closed = undefined; this.#closing = undefined;
          }
        }
      }
    })();
  }
}
