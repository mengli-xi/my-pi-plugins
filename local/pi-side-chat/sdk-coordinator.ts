import { ExtensionSelectorComponent, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { MainContextSource } from "./effective-context.ts";
import { SideRuntime, SideStartupCleanupError, type SideDisposeCause } from "./sdk-runtime.ts";
import { sideExecutionPlan, sidePresentationFactories } from "./sdk-factories.ts";

import { TerminalOwner } from "pi-session-runtime/terminal-owner";
import type { ManagedViewCloseReason } from "pi-session-runtime/managed-interactive";
import { SideView } from "./sdk-view.ts";

/** Main lifecycle fence; opening cannot resurrect a Side after shutdown or destroy. */
export class SdkSideCoordinator {
  private readonly pi: ExtensionAPI;
  private readonly source: MainContextSource;
  private active?: SideRuntime;
  private retiring?: SideRuntime;
  private startupCleanup?: SideStartupCleanupError;
  private view?: SideView;
  private terminal?: TerminalOwner;
  private closing?: Promise<boolean>;
  private foreground?: Promise<void>;
  private opening?: Promise<SideRuntime>;
  private generation = 0;
  private cancelConfirmation?: () => void;
  private confirmationOwnsInput = false;
  private toggling = false;
  constructor(pi: ExtensionAPI, source: MainContextSource) { this.pi = pi; this.source = source; }
  get side(): SideRuntime | undefined { return this.active ?? this.retiring; }
  mainTerminalOccupied(): Promise<unknown> | undefined { return this.foreground ?? this.opening; }
  rememberContext(ctx: ExtensionContext): void {
    this.generation++;
    if (ctx.hasUI) ctx.ui.setWidget("side-terminal-owner", tui => {
      this.terminal ??= new TerminalOwner(tui, ctx.ui, () => this.pi.getSettings().theme);
      return { render: () => [], invalidate() {} };
    });
  }
  notifyMainSettled(): void { this.view?.notifyMainSettled(); }
  async toggle(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || !this.terminal) throw new Error("Side requires an interactive Main terminal");
    if (this.view?.managed.attached) { await this.view.managed.close(); return; }
    if (this.toggling) return;
    this.toggling = true;
    // Reject submit before the editor clears it; all typed characters remain in Main's draft.
    // The native-context confirmation owns its own input and must still accept Enter.
    const stop = ctx.ui.onTerminalInput(data => {
      if (!this.terminal?.isMainForeground || this.confirmationOwnsInput) return;
      const keys = getKeybindings();
      if (keys.matches(data, "tui.input.submit") || keys.matches(data, "app.message.followUp")) {
        if (!isKeyRelease(data) && !isKeyRepeat(data)) ctx.ui.notify("Side is opening; input stays in the Main draft.", "info");
        return { consume: true };
      }
    });
    let foreground: Promise<void> | undefined;
    try {
      await this.closing;
      const side = await this.open(ctx);
      foreground = this.view!.open(side, this.terminal);
      this.foreground = foreground;
      await foreground;
    } finally {
      stop(); this.toggling = false;
      if (this.foreground === foreground) this.foreground = undefined;
    }
  }
  async open(ctx: ExtensionContext, acceptNativeOnce = false): Promise<SideRuntime> {
    if (this.closing) await this.closing;
    if (this.retiring || this.startupCleanup) throw new Error("Side cleanup is pending; retry destroy before opening another Side");
    if (this.active) return this.active;
    if (this.opening) return this.opening;
    const generation = this.generation;
    const opening = this.create(ctx, acceptNativeOnce, generation);
    this.opening = opening;
    try { return await opening; } finally { if (this.opening === opening) this.opening = undefined; }
  }
  private async create(ctx: ExtensionContext, acceptNativeOnce: boolean, generation: number): Promise<SideRuntime> {
    if (!ctx.model) throw new Error("Side requires a model");
    let selection;
    try { selection = this.source.select(ctx, acceptNativeOnce); }
    catch (error) {
      if (!ctx.hasUI || acceptNativeOnce) throw error;
      let wasCancelled = false;
      let finishConfirmation: ((accepted: boolean) => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        this.cancelConfirmation = () => {
          wasCancelled = true;
          reject(new Error("Side opening cancelled"));
          finishConfirmation?.(false);
        };
      });
      let accepted: boolean;
      try {
        // Keep Main's editor and paste map intact; editor-slot custom UI restores
        // raw placeholder text with setText and discards the expanded paste contents.
        accepted = await Promise.race([ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
          finishConfirmation = accepted => {
            // A terminal packet can contain more keys after this one. Restore the guard
            // before done synchronously gives focus back to Main, not in a microtask.
            this.confirmationOwnsInput = false;
            done(accepted);
          };
          this.confirmationOwnsInput = !wasCancelled;
          const selector = new ExtensionSelectorComponent("Main effective context unavailable\nComplete a Main turn for the actual request context. Use native records for this Side only instead? They may contain incomplete summaries or unprocessed history.",
            ["Yes", "No"], option => finishConfirmation!(option === "Yes"), () => finishConfirmation!(false), { tui });
          if (wasCancelled) finishConfirmation(false);
          return selector;
        }, { overlay: true }), cancelled]);
      } finally { this.confirmationOwnsInput = false; this.cancelConfirmation = undefined; }
      if (!accepted) throw error;
      selection = this.source.select(ctx, true);
    }
    if (generation !== this.generation) throw new Error("Main session changed while opening Side");
    const options = { cwd: ctx.cwd, agentDir: getAgentDir(), parentSettings: this.pi.getSettings(), projectTrusted: ctx.isProjectTrusted(),
      provider: ctx.model.provider, model: ctx.model.id, thinkingLevel: ctx.thinkingLevel, selection, systemPrompt: ctx.getSystemPrompt(), cacheLineageId: ctx.sessionManager.getSessionId() };
    // The plan is independent of the seed id except the process scope factory.
    const plan = await sideExecutionPlan(this.pi, ctx, options.agentDir);
    const view = new SideView(() => this.destroy(), error => ctx.ui.notify(`Side: ${error instanceof Error ? error.message : String(error)}`, "error"));
    const presentation = await sidePresentationFactories(ctx, view.managed.lifecycle, plan);
    if (generation !== this.generation) throw new Error("Main session changed while planning Side");
    return SideRuntime.create({ ...options, tools: plan.tools, modelScope: plan.modelScope,
      beforeDispose: plan.beforeDispose, beforeExecution: plan.beforeExecution,
      factories: async id => [...await plan.factories(id), ...presentation, view.extension, view.managed.extension],
      onError: error => ctx.ui.notify(`Side: ${error.error}`, "error"),
    }).then(async side => {
      if (generation !== this.generation) {
        // Own the unpublished runtime before attempting cancellation. A rejected
        // destroy must remain reachable by the next coordinator destroy call.
        this.retiring = side; this.view = view;
        await side.destroy("main-shutdown");
        if (this.retiring === side) this.retiring = undefined;
        if (this.view === view) this.view = undefined;
        throw new Error("Main session changed while opening Side");
      }
      this.active = side; this.view = view; return side;
    }).catch(error => {
      if (error instanceof SideStartupCleanupError) { this.startupCleanup = error; this.view = view; }
      throw error;
    });
  }
  destroy(reason: ManagedViewCloseReason = "return", cause: SideDisposeCause = "destroy"): Promise<boolean> {
    if (this.closing) { if (reason === "quit") void this.view?.managed.close(reason); return this.closing; }
    this.generation++;
    this.cancelConfirmation?.();
    const existed = !!(this.active || this.retiring || this.startupCleanup || this.opening);
    const operation = (async () => {
      try { await this.opening; }
      catch (error) {
        // A resource-free opening cancellation needs no cleanup. A retained
        // runtime/seed means opening itself failed to clean up: propagate that
        // failure once, rather than silently retrying or reporting success.
        if (this.retiring || this.startupCleanup) throw error;
      }
      const view = this.view;
      await view?.managed.close(reason);
      const active = this.active ?? this.retiring;
      if (active) { this.retiring = active; this.active = undefined; }
      await active?.destroy(cause);
      if (this.retiring === active) this.retiring = undefined;
      const startupCleanup = this.startupCleanup;
      await startupCleanup?.retryCleanup();
      if (this.startupCleanup === startupCleanup) this.startupCleanup = undefined;
      if (this.view === view) this.view = undefined;
      return existed;
    })();
    this.closing = operation;
    return operation.finally(() => { if (this.closing === operation) this.closing = undefined; });
  }
  async shutdown(reason?: string): Promise<void> {
    const closeReason = reason === "quit" ? "quit" : "return";
    try { await this.destroy(closeReason, "main-shutdown"); }
    finally { this.terminal?.dispose(closeReason); this.terminal = undefined; }
  }
}
