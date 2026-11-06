import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { watchFile, unwatchFile } from "node:fs";

/** Keep initialization frames private while still forwarding terminal queries/modes. */
export function deferTerminalFrames(terminal: Terminal, retainForTimeout = false) {
  const original = terminal.write;
  const begin = "\x1b[?2026h", end = "\x1b[?2026l";
  let pending = "", inside = false, released = false, restored = false;
  let frames = "", currentFrame = "";
  const restore = () => {
    if (restored) return;
    restored = true;
    terminal.write = original;
  };
  terminal.write = data => {
    pending += data;
    while (pending) {
      const marker = inside ? end : begin;
      const index = pending.indexOf(marker);
      if (index >= 0) {
        if (!inside && index) original.call(terminal, pending.slice(0, index));
        if (retainForTimeout) {
          if (inside) { frames += currentFrame + pending.slice(0, index) + marker; currentFrame = ""; }
          else currentFrame = marker;
        }
        pending = pending.slice(index + marker.length);
        inside = !inside;
        if (released && !inside) {
          const rest = pending; pending = "";
          restore();
          if (rest) original.call(terminal, rest);
          return;
        }
      } else {
        // A Terminal implementation may split either delimiter across writes.
        let keep = Math.min(pending.length, marker.length - 1);
        while (keep > 0 && !marker.startsWith(pending.slice(-keep))) keep--;
        const safe = pending.slice(0, pending.length - keep);
        if (!inside && safe) original.call(terminal, safe);
        if (inside && retainForTimeout) currentFrame += safe;
        pending = pending.slice(pending.length - keep);
        return;
      }
    }
  };
  return {
    release(replay = false) {
      if (replay && frames) original.call(terminal, frames);
      frames = ""; currentFrame = ""; retainForTimeout = false;
      released = true;
      if (!inside && !pending) restore();
    },
    dispose() { pending = ""; frames = ""; currentFrame = ""; restore(); },
  };
}

// Function-local links also compose across bundled consumers. Unknown wrappers remain opaque:
// never replace another owner's method, even when it retains one of our retired wrappers.
const gateKey = Symbol.for("pi.session-runtime.terminal-gate.v1");
type TerminalMethod = (...args: never[]) => unknown;
interface GateLink { version: 1; previous: TerminalMethod; retired: () => boolean }
function liveTerminalMethod<T extends TerminalMethod>(method: T): T {
  let current: TerminalMethod = method;
  while (true) {
    const link = (current as TerminalMethod & { [gateKey]?: GateLink })[gateKey];
    if (!link || link.version !== 1 || typeof link.previous !== "function" || typeof link.retired !== "function" || !link.retired()) break;
    current = link.previous;
  }
  return current as T;
}

/** Gate only public Terminal output. Uncontrolled process.stdout writes are outside this contract. */
export function gateTerminal(terminal: Terminal, foreground: () => boolean) {
  const original = { write: terminal.write, setTitle: terminal.setTitle, setProgress: terminal.setProgress, setProgramStatus: terminal.setProgramStatus };
  let title: string | undefined, progress: boolean | undefined, status: Parameters<Terminal["setProgramStatus"]>[0] | undefined;
  let restored = false;
  const wrappers: typeof original = {
    write(data) { if (restored || foreground()) liveTerminalMethod(original.write).call(terminal, data); },
    setTitle(value) { if (!restored) title = value; if (restored || foreground()) liveTerminalMethod(original.setTitle).call(terminal, value); },
    setProgress(value) { if (!restored) progress = value; if (restored || foreground()) liveTerminalMethod(original.setProgress).call(terminal, value); },
    setProgramStatus(value) { if (!restored) status = value; if (restored || foreground()) liveTerminalMethod(original.setProgramStatus).call(terminal, value); },
  };
  for (const name of Object.keys(original) as (keyof typeof original)[]) {
    Object.defineProperty(wrappers[name], gateKey, { value: { version: 1, previous: original[name], retired: () => restored } satisfies GateLink });
  }
  Object.assign(terminal, wrappers);
  return {
    resume() {
      if (restored || !foreground()) return;
      if (title !== undefined && terminal.setTitle === wrappers.setTitle) liveTerminalMethod(original.setTitle).call(terminal, title);
      if (status !== undefined && terminal.setProgramStatus === wrappers.setProgramStatus) liveTerminalMethod(original.setProgramStatus).call(terminal, status);
      if (progress !== undefined && terminal.setProgress === wrappers.setProgress) liveTerminalMethod(original.setProgress).call(terminal, progress);
    },
    restore() {
      restored = true;
      title = undefined; progress = undefined; status = undefined;
      for (const name of Object.keys(original) as (keyof typeof original)[]) {
        if (terminal[name] === wrappers[name]) Object.assign(terminal, { [name]: liveTerminalMethod(original[name]) });
      }
    },
  };
}

/** One process-wide foreground lease shared by Side and Subagents, even across loader copies. */
const key = Symbol.for("pi.session-runtime.terminal-owner.v1");
interface Registry { version: 1; owner?: TerminalOwner; hasManagedView?: boolean }
export type TerminalReleaseReason = "return" | "quit";
function registry(): Registry {
  const global = globalThis as typeof globalThis & { [key]?: Registry };
  const existing = global[key];
  if (existing && existing.version !== 1) throw new Error("Incompatible terminal owner registry");
  return global[key] ??= { version: 1 };
}

export class TerminalOwner {
  readonly tui: TUI;
  readonly ui: ExtensionUIContext;
  #foreground = true;
  #gate: ReturnType<typeof gateTerminal>;
  #restoreKeys?: () => void;
  #theme?: ExtensionUIContext["theme"];
  #themeName?: string;
  #readThemeSetting: () => string | undefined;
  #disposeInput: () => void;
  #watchPath?: string;
  #watchName?: string;
  #watch?: () => void;
  #restoreWatcher = false;
  #disposed = false;
  #leaseGeneration = 0;
  constructor(tui: TUI, ui: ExtensionUIContext, readThemeSetting: () => string | undefined) {
    this.tui = tui; this.ui = ui;
    this.#readThemeSetting = readThemeSetting;
    this.#gate = gateTerminal(tui.terminal, () => this.#foreground);
    this.#restoreWatcher = registry().hasManagedView === true;
    if (this.#restoreWatcher) this.watchMainTheme();
    this.#disposeInput = ui.onTerminalInput(() => {
      // Settings selectors commit after input dispatch; observe their public setting afterwards.
      queueMicrotask(() => { if (!this.#disposed && this.#foreground && this.#restoreWatcher) this.watchMainTheme(); });
      return undefined;
    });
  }
  get isMainForeground() { return this.#foreground; }
  get theme() { return this.#theme ?? this.ui.theme; }
  get themeName() { return this.#themeName; }
  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#disposed) throw new Error("Terminal owner is disposed");
    const shared = registry();
    if (shared.owner) throw new Error("Another child view already owns the terminal; return to Main first");
    // ui.theme is Pi's live theme proxy, not a Theme instance. Passing it back to setTheme
    // is interpreted as a name and silently falls back to the system palette.
    const name = this.#readThemeSetting();
    if (!name || name.includes("/") || name !== this.ui.theme.name) throw new Error("Child views require a single named Main theme; automatic theme pairs and anonymous in-memory themes are not supported yet. Select a named theme in Main first.");
    const snapshot = name ? this.ui.getTheme(name) : undefined;
    if (!snapshot) throw new Error("Cannot enter a child view: Main theme must have a loadable public name");
    shared.owner = this;
    const generation = ++this.#leaseGeneration;
    shared.hasManagedView = true;
    this.#restoreKeys = undefined; this.#theme = snapshot; this.#themeName = name;
    try {
      // Keep idle Main bindings SDK-free. The child mutates the canonical TUI state
      // cell, which may differ from this owner's physical import under native/Jiti.
      const { getSessionAssemblyPublicModules } = await import("pi-session-runtime/session-assembly");
      signal?.throwIfAborted();
      if (generation !== this.#leaseGeneration || shared.owner !== this || this.#disposed) throw new Error("Terminal handoff abandoned");
      const tui = getSessionAssemblyPublicModules()["@earendil-works/pi-tui"];
      const keys = tui.getKeybindings();
      this.#restoreKeys = () => tui.setKeybindings(keys);
      await this.tui.terminal.drainInput(100, 20);
      signal?.throwIfAborted();
      if (generation !== this.#leaseGeneration || shared.owner !== this || this.#disposed) throw new Error("Terminal handoff abandoned");
      this.tui.stop({ preserveScreen: true });
      this.#foreground = false;
    } catch (error) { if (generation === this.#leaseGeneration && shared.owner === this) shared.owner = undefined; throw error; }
  }
  restore(reason: TerminalReleaseReason = "return"): void {
    if (registry().owner !== this) return;
    this.#leaseGeneration++;
    if (reason === "quit") {
      // Main's native interactive shutdown may already have stopped its TUI. Do not restart
      // protocols or repaint during teardown; child stop has released the foreground terminal.
      this.#restoreKeys = undefined;
      registry().owner = undefined;
      return;
    }
    this.#foreground = true;
    const restoreKeys = this.#restoreKeys; this.#restoreKeys = undefined;
    restoreKeys?.();
    try {
      const result = this.ui.setTheme(this.#themeName!);
      if (!result.success) {
        if (this.#theme) this.ui.setTheme(this.#theme);
        this.ui.notify(`Unable to reload Main theme; retaining its saved palette: ${result.error}`, "warning");
      }
      this.#restoreWatcher = true;
      this.watchMainTheme();
    } finally {
      this.tui.start(); this.#gate.resume(); this.tui.requestRender(true);
      registry().owner = undefined;
    }
  }
  private watchMainTheme(): void {
    if (this.#disposed) return;
    const name = this.#readThemeSetting();
    if (name === this.#watchName) return;
    this.stopThemeWatch();
    this.#watchName = name;
    if (!name || name.includes("/")) return;
    const path = this.ui.getAllThemes().find(theme => theme.name === name)?.path;
    if (!path) return;
    this.#watchPath = path;
    // Pi has one global theme callback, last installed by the child mode. Its native file watcher
    // still loads colors, but targets the stopped child TUI. Reapply through Main's public API so
    // custom theme edits repaint Main too. This reference-owned watcher never touches Pi internals.
    this.#watch = () => {
      if (this.#disposed || !this.#foreground || this.#readThemeSetting() !== name) return;
      const result = this.ui.setTheme(name);
      if (!result.success) this.ui.notify(`Main theme update failed: ${result.error}`, "warning");
    };
    watchFile(path, { persistent: false, interval: 200 }, this.#watch);
  }
  private stopThemeWatch(): void {
    if (this.#watchPath && this.#watch) unwatchFile(this.#watchPath, this.#watch);
    this.#watchPath = undefined; this.#watch = undefined; this.#watchName = undefined;
  }
  dispose(reason: TerminalReleaseReason = "return"): void {
    this.#disposed = true;
    try { this.restore(reason); }
    finally { this.#disposeInput(); this.stopThemeWatch(); this.#gate.restore(); }
  }
}
