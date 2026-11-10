import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { ManagedInteractive } from "pi-session-runtime/managed-interactive";
import type { InputPolicy, ManagedCommand } from "pi-session-runtime/input-policy";
import type { TerminalOwner } from "pi-session-runtime/terminal-owner";
import { InlineToastController } from "pi-li-uikit/inline-toast";
import { installSideVisibility } from "./compat/pi-1.2-side-visibility.ts";
import { editInParentTerminal } from "./external-editor.ts";
import type { SideRuntime } from "./sdk-runtime.ts";
import { publishSideStatus, withdrawSideStatus } from "./statusline.ts";
import { observeCache, type CacheObservation } from "./cache-observation.ts";

// Native model/thinking defaults write this Side's SettingsManager.inMemory only.
// Do not block thinking-save globally: it shares Ctrl+S with model-selector save.
const BLOCKED: InputPolicy["blockedActions"] = ["app.session.new", "app.session.tree", "app.session.fork", "app.session.resume", "app.message.dequeue"];
export function hasSideAnswer(side: SideRuntime): boolean {
  // Match native copy's skip of empty aborted assistants; their presence is not a Side answer.
  const entry = [...side.session.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant"
    && !(entry.message.stopReason === "aborted" && entry.message.content.length === 0));
  return !!entry && !side.inheritedEntryIds.has(entry.id) && entry.type === "message" && entry.message.role === "assistant"
    && entry.message.content.some(block => block.type === "text" && block.text.length > 0);
}

/** Side owns its command/destroy policy; all rendering and handoff stay in shared/native owners. */
export class SideView {
  readonly managed: ManagedInteractive;
  private side?: SideRuntime;
  private ctx?: ExtensionContext;
  private toast?: InlineToastController;
  private confirmation?: InlineToastController;
  private cache: CacheObservation = { status: "unknown", cacheRead: 0, cacheWrite: 0, promptTokens: 0 };
  private readonly destroy: () => Promise<boolean>;
  private readonly report: (error: unknown) => void;
  constructor(destroy: () => Promise<boolean>, report: (error: unknown) => void) {
    this.destroy = destroy; this.report = report;
    this.managed = new ManagedInteractive(report, async () => { await this.side?.interrupt(); });
    this.managed.configureMode = mode => installSideVisibility(mode, this.side!.inheritedEntryIds, this.side!.boundaryId);
  }
  readonly extension: ExtensionFactory = pi => {
    // Track execution while detached too; reopening must retain this Side's latest usage.
    pi.on("agent_end", event => {
      const last = [...event.messages].reverse().find(message => message.role === "assistant");
      this.cache = last?.role === "assistant" ? observeCache(last.usage)
        : { status: "unknown", cacheRead: 0, cacheWrite: 0, promptTokens: 0 };
      if (this.ctx) publishSideStatus(pi, this.ctx, this.cache);
    });
    this.managed.lifecycle.onAttach(() => {
      const stop = pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        this.ctx = ctx;
        this.toast = new InlineToastController(ctx.ui, { key: "side-main-finished" });
        this.confirmation = new InlineToastController(ctx.ui, { key: "side-destroy-confirmation" });
        publishSideStatus(pi, ctx, this.cache);
      });
      const detach = this.managed.lifecycle.onDetach(() => {
        stop(); detach(); this.toast?.dispose(); this.confirmation?.dispose();
        withdrawSideStatus(pi, this.ctx); this.ctx = undefined;
        this.side?.destroyConfirmation.cancel();
      });
    });
  };
  notifyMainSettled() { if (this.managed.attached) this.toast?.show("Main conversation finished", { durationMs: 5000 }); }
  private notify = (message: string) => { this.ctx?.ui.notify(message, "info"); };
  private commands(side: SideRuntime): ManagedCommand[] {
    const back = () => this.managed.requestReturn();
    const noCopy = () => this.notify("No Side answer to copy yet.");
    return [
      ...["side", "exit", "quit"].map(name => ({ name, description: "Return to Main", run: back })),
      { name: "copy", description: "Copy the last Side answer", get run() { return hasSideAnswer(side) ? "native" as const : noCopy; } },
      ...["session", "hotkeys", "changelog"].map(name => ({ name, description: `Show Side ${name}`, run: "native" as const })),
      { name: "compact", description: "Compact Side context; optional free-text instructions", acceptsArguments: true, getArgumentCompletions: () => null, run: "native" },
      { name: "model", description: "Choose a model within the Side scope; optional model name", acceptsArguments: true,
        getArgumentCompletions: prefix => side.runtime.services.modelRuntime.getAvailableSnapshot().map(model => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` })).filter(item => item.value.startsWith(prefix)), run: "native" },
      { name: "help", description: "Show Side commands and keys", run: () => this.notify("/model /copy /session /compact [instructions] /hotkeys /changelog /help · Alt+/ or /side returns to Main · Ctrl+C interrupts when busy, returns when idle · Empty Ctrl+D twice destroys Side") },
    ];
  }
  async open(side: SideRuntime, owner: TerminalOwner): Promise<void> {
    this.side = side;
    const policy: InputPolicy = {
      commands: this.commands(side), blockedActions: BLOCKED, returnKey: "alt+/",
      busy: () => side.busy, interrupt: () => side.interrupt(), leave: this.managed.requestReturn,
      admit: async text => {
        if (side.busy) throw new Error("Side is busy; interrupt or wait before submitting another message");
        // Admission is synchronous; never fence keyboard input for the whole model request.
        void side.prompt(text).catch(this.report);
      },
      unsupported: command => command === "subagents" ? "Return to Main before opening /subagents" : `/${command} is unavailable in Side. Use /help for supported commands.`,
      emptyDelete: () => {
        if (side.destroyConfirmation.press() === "armed") this.confirmation?.show("Press Ctrl+D again within 4 seconds to destroy Side", { durationMs: 4000, tone: "warning" });
        else { this.confirmation?.clear(); queueMicrotask(() => { void this.destroy().catch(this.report); }); }
      },
      onInput: data => {
        const keys = getKeybindings();
        const press = !isKeyRelease(data) && !isKeyRepeat(data);
        if (matchesKey(data, "escape") && side.destroyConfirmation.isActive()) {
          if (press) { side.destroyConfirmation.cancel(); this.confirmation?.clear(); } return { consume: true };
        }
        if (press && !matchesKey(data, "ctrl+d") && !keys.matches(data, "app.exit")) { side.destroyConfirmation.cancel(); this.confirmation?.clear(); }
        if (keys.matches(data, "app.message.copy") && !hasSideAnswer(side)) { if (press) this.notify("No Side answer to copy yet."); return { consume: true }; }
        if (keys.matches(data, "app.editor.external")) {
          if (!press) return { consume: true };
          const ctx = this.ctx, command = process.env.VISUAL || process.env.EDITOR;
          if (!command) this.notify("Set VISUAL or EDITOR to use an external editor");
          else if (ctx) {
            const draft = ctx.ui.getEditorText();
            void this.managed.yieldTerminal(signal => editInParentTerminal(command, draft, signal)).then(text => {
              if (text !== undefined && this.ctx === ctx) ctx.ui.setEditorText(text);
            }).catch(this.report);
          }
          return { consume: true };
        }
      },
    };
    await this.managed.open(side.runtime, owner, policy);
  }
}
