import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { InlineToastController } from "pi-li-uikit/inline-toast";
import { rewritePromptCacheLineage } from "./cache-lineage.ts";
import type { MainContextSnapshot } from "./effective-context.ts";
import { type BtwStatusSurface, createBtwStatus } from "./statusline.ts";

const MAX_HISTORY = 20;
const MAX_OUTPUT_TOKENS = 2_048;
/** BTW's own toast key: one statusline-style surface may have only one owner. */
export const BTW_TOAST_KEY = "pi-side-chat:btw-toast";
/** Long enough to read over the editor, short enough not to sit there. */
export const BTW_TOAST_DURATION_MS = 5_000;
/**
 * The completion notice. It says what finished and how to read it, and never
 * carries the answer: the answer belongs in the browser, not over the editor.
 */
export const BTW_ANSWERED_TOAST = "BTW answered \u00b7 /btw to view";

export const BTW_BOUNDARY_PROMPT = `BTW side question.

You are answering a one-off question using an inherited snapshot of a parent session. The parent session continues independently.

Treat the inherited conversation as background context only. Do not resume or complete the parent's task, plans, todos, tool calls, edits, or commitments. Answer only the question below. No tools are available, and you must not claim to inspect, execute, modify, or communicate anything.

Question:
`;

export interface BtwAnswer {
  question: string;
  answer: string;
  model: string;
  usage: Usage;
  exactPrefix: boolean;
  createdAt: number;
}

export interface BtwPending {
  state: "pending";
  question: string;
  createdAt: number;
}

export type BtwEntry = BtwAnswer | BtwPending;

export function btwIsPending(entry: BtwEntry): entry is BtwPending {
  return "state" in entry && entry.state === "pending";
}

export interface BtwBrowserUpdates {
  subscribe(listener: () => void): () => void;
  signal: AbortSignal;
}

/** Keep selection, scroll and read state stable across pending → final. */
export function btwAnswerKey(answer: Pick<BtwAnswer, "createdAt" | "question">): string {
  return `${answer.createdAt}\u0000${answer.question}`;
}

/**
 * Which finished answers the user has actually been shown.
 *
 * The browser displays and reports; the history owner keeps the state, so it
 * dies with the answer it belongs to and with the session.
 */
export interface BtwReadState {
  /** False until the answer's body has been drawn where it could be read. */
  isRead(answer: BtwAnswer): boolean;
  /** Record that the answer's body was just drawn. */
  markRead(answer: BtwAnswer): void;
}

export function displayText(value: string): string {
  return stripTerminalSequences(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    "",
  );
}

function textFrom(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `request ${message.stopReason}`);
  }
  const text = message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> =>
      part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
  if (!text) throw new Error("the model returned no text");
  return text;
}

/** How one runtime's BTW answers reach the user. */
export interface BtwPresenter {
  /** Say an answer arrived, without taking focus or opening anything. */
  notifyAnswered(ctx: ExtensionContext, answer: BtwAnswer): Promise<void>;
  /**
   * Open the browser over the live history, so a late answer joins the list.
   * The promise settles when the browser closes, which is how the controller
   * knows a completion notice would only land behind it.
   */
  showBrowser(
    ctx: ExtensionContext,
    history: () => readonly BtwEntry[],
    read: BtwReadState,
    updates: BtwBrowserUpdates,
  ): Promise<void>;
  /** Release any widget or timer this presenter still owns for the runtime. */
  dispose?(): void;
}

/** Who currently owns Main's terminal. Side is the only thing that takes it. */
export interface MainTerminalGate {
  /**
   * A promise for the end of the current hold on Main's terminal, or
   * `undefined` when Main owns it. Only settling matters; the resolved value
   * and any rejection are ignored.
   */
  occupied(): Promise<unknown> | undefined;
}

/**
 * The default presenter for a TUI session.
 *
 * Submission opens the live browser; completion updates it in place. If the
 * user already dismissed it, a transient notice leaves the draft untouched.
 * The toast controller belongs to whichever runtime created it, so
 * `dispose()` takes its widget and expiry timer down with the session.
 */
class DefaultBtwPresenter implements BtwPresenter {
  private toast: InlineToastController | undefined;

  async notifyAnswered(ctx: ExtensionContext, answer: BtwAnswer): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify(displayText(answer.answer), "info");
      return;
    }
    this.toast ??= new InlineToastController(ctx.ui, {
      key: BTW_TOAST_KEY,
      placement: "aboveEditor",
    });
    this.toast.show(BTW_ANSWERED_TOAST, { tone: "success", durationMs: BTW_TOAST_DURATION_MS });
  }

  async showBrowser(
    ctx: ExtensionContext,
    history: () => readonly BtwEntry[],
    read: BtwReadState,
    updates: BtwBrowserUpdates,
  ): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      const latest = history().at(-1);
      if (latest && !btwIsPending(latest)) {
        ctx.ui.notify(displayText(latest.answer), "info");
        read.markRead(latest);
      }
      return;
    }
    // Loaded on first use: the browser pulls in the Markdown renderer, and a
    // session that never opens it should not pay for that at startup.
    const { showBtwBrowser } = await import("./btw-browser.ts");
    await showBtwBrowser(ctx, history, read, updates);
  }

  dispose(): void {
    const toast = this.toast;
    this.toast = undefined;
    try {
      toast?.dispose();
    } catch {
      // The widget belongs to a session Pi may already have torn down. The
      // timer is cleared either way, and a replaced session must still start.
    }
  }
}

export class BtwController {
  private history: BtwAnswer[] = [];
  private active?: AbortController;
  private pending?: BtwPending;
  private readonly listeners = new Set<() => void>();
  private opening?: { owner?: AbortController; abandon: () => void };
  private statusOwner?: { controller: AbortController; ctx: ExtensionContext };
  private held?: { answer: BtwAnswer; abandon: () => void };
  /** The keys of the answers already shown, dropped with the answers themselves. */
  private readonly readKeys = new Set<string>();
  /** The open browser, while `showBrowser` has not returned. */
  private browser?: AbortController;
  private generation = 0;
  private readonly presenter: BtwPresenter;
  private readonly status: BtwStatusSurface;
  private readonly terminal?: MainTerminalGate;
  private readonly reads: BtwReadState = {
    isRead: (answer) => this.readKeys.has(btwAnswerKey(answer)),
    markRead: (answer) => { this.readKeys.add(btwAnswerKey(answer)); },
  };

  constructor(
    presenter: BtwPresenter = new DefaultBtwPresenter(),
    status: BtwStatusSurface = createBtwStatus(),
    terminal?: MainTerminalGate,
  ) {
    this.presenter = presenter;
    this.status = status;
    this.terminal = terminal;
  }

  startSession(): void {
    this.reset();
  }

  shutdown(): void {
    this.reset();
  }

  cancel(): boolean {
    const controller = this.active;
    if (!controller) return false;
    controller.abort();
    this.active = undefined;
    this.pending = undefined;
    if (this.opening?.owner === controller) {
      this.opening.abandon();
      this.opening = undefined;
    }
    this.changed();
    this.clearStatus(controller);
    return true;
  }

  answers(): readonly BtwAnswer[] {
    return this.history.map((answer) => structuredClone(answer));
  }

  /** The answer waiting for Main to own its terminal again, if any. */
  heldAnswer(): BtwAnswer | undefined {
    return this.held ? structuredClone(this.held.answer) : undefined;
  }

  /** Which answers the user has been shown. The browser reads and reports here. */
  readState(): BtwReadState {
    return this.reads;
  }

  /** True while the answer browser is on screen over Main's editor. */
  browserIsOpen(): boolean {
    return this.browser !== undefined;
  }

  /**
   * Start a question without waiting for it. Pi awaits an extension command
   * handler before it reads the next input, so a handler that awaits the answer
   * also delays `/btw cancel` until the answer has arrived.
   *
   * The returned promise settles when *this* question is done, and never
   * rejects: its failures reach the user through `onError`. Each caller holds
   * the one it started, so a cancelled question that drains late cannot be
   * mistaken for the question that replaced it. `active` stays the single
   * answer to which request is current.
   */
  start(
    question: string,
    ctx: ExtensionContext,
    getSnapshot: () => MainContextSnapshot,
    onError: (error: unknown) => void,
  ): Promise<void> {
    return (async () => {
      try {
        const previous = this.active;
        const completion = this.run(question, ctx, getSnapshot);
        // The panel owns input, not Main's agent run. Never await its dismissal
        // or the provider here before returning control to the dispatcher.
        if (!previous && this.active && ctx.mode === "tui" && ctx.hasUI) {
          void this.openBrowser(ctx, this.active).catch((error) => {
            try { onError(error); } catch { /* Keep reporter failures contained. */ }
          });
        }
        await completion;
      } catch (error) {
        try {
          onError(error);
        } catch {
          // A failing reporter must not become an unhandled rejection.
        }
      }
    })();
  }

  /**
   * Open the answer browser. The presenter reads the history through this
   * closure rather than a copy, so an answer that lands while the browser is
   * open joins the list, and a replaced session empties it.
   */
  async showBrowser(ctx: ExtensionContext): Promise<void> {
    return this.openBrowser(ctx);
  }

  private entries(): readonly BtwEntry[] {
    return this.pending ? [...this.history, this.pending] : this.history;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private async openBrowser(ctx: ExtensionContext, owner?: AbortController): Promise<void> {
    if (this.browser || this.opening) return;
    if (this.entries().length === 0) {
      ctx.ui.notify("Usage: /btw <question>", "info");
      return;
    }
    const generation = this.generation;
    let abandon!: () => void;
    const abandoned = new Promise<false>((resolve) => { abandon = () => resolve(false); });
    const opening = { owner, abandon };
    this.opening = opening;
    try {
      let occupied = this.terminal?.occupied();
      while (occupied) {
        if (!await Promise.race([occupied.then(() => true, () => true), abandoned])) return;
        if (generation !== this.generation || owner?.signal.aborted) return;
        occupied = this.terminal?.occupied();
      }
      if (generation !== this.generation || owner?.signal.aborted) return;
      const token = new AbortController();
      if (this.opening === opening) this.opening = undefined;
      this.browser = token;
      try {
        await this.presenter.showBrowser(ctx, () => this.entries(), this.reads, {
          signal: token.signal,
          subscribe: (listener) => {
            this.listeners.add(listener);
            return () => { this.listeners.delete(listener); };
          },
        });
      } finally {
        token.abort();
        if (this.browser === token) this.browser = undefined;
      }
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  async run(
    question: string,
    ctx: ExtensionContext,
    getSnapshot: () => MainContextSnapshot,
  ): Promise<BtwAnswer | undefined> {
    const trimmed = question.trim();
    if (!trimmed) {
      await this.showBrowser(ctx);
      return undefined;
    }
    if (this.active) throw new Error("A BTW question is already running");
    if (!ctx.model) throw new Error("BTW requires an active model");

    const generation = this.generation;
    const controller = new AbortController();
    this.active = controller;
    const pending: BtwPending = { state: "pending", question: trimmed, createdAt: Date.now() };
    this.pending = pending;
    this.changed();
    this.statusOwner = { controller, ctx };
    this.status.show(ctx);
    try {
      const snapshot = getSnapshot();
      const model = ctx.model;
      const response = await ctx.modelRegistry.complete(model, {
        systemPrompt: snapshot.systemPrompt,
        messages: [
          ...convertToLlm(snapshot.messages),
          {
            role: "user",
            content: `${BTW_BOUNDARY_PROMPT}${trimmed}`,
            timestamp: Date.now(),
          },
        ],
        tools: [],
      }, {
        signal: controller.signal,
        sessionId: randomUUID(),
        maxTokens: MAX_OUTPUT_TOKENS,
        reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
        onPayload: (payload: unknown) =>
          rewritePromptCacheLineage(model.api, payload, snapshot.cacheLineageId),
      });
      if (controller.signal.aborted || generation !== this.generation) return undefined;
      const answer: BtwAnswer = {
        question: trimmed,
        answer: textFrom(response),
        model: `${response.provider}/${response.model}`,
        usage: structuredClone(response.usage),
        exactPrefix: snapshot.exactPrefix,
        createdAt: pending.createdAt,
      };
      this.history.push(answer);
      // The evicted answer takes its read state with it: nothing outlives the
      // entry it describes.
      const evicted = this.history.length > MAX_HISTORY ? this.history.shift() : undefined;
      if (evicted) this.readKeys.delete(btwAnswerKey(evicted));
      // The question is answered here. Holding the pending row and `active`
      // until the notice has been delivered would keep claiming a request is
      // running and let `/btw cancel` pretend it could still stop an answer
      // that is already in history.
      this.finish(controller);
      await this.present(ctx, answer, generation);
      return structuredClone(answer);
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      // Main notifications are hidden by the custom panel; reveal the failure.
      if (this.active === controller) this.browser?.abort();
      if (this.opening?.owner === controller) {
        this.opening.abandon();
        this.opening = undefined;
      }
      throw error;
    } finally {
      this.finish(controller);
    }
  }

  /**
   * Announce the answer once Main can own its terminal again.
   *
   * Side's handoff swaps Main's editor for a custom container and stops Main's
   * TUI. A notice posted in between would expire unseen behind Side, so it
   * waits here instead. The answer is already in history, so a notice that
   * never gets posted loses nothing else.
   */
  private async present(ctx: ExtensionContext, answer: BtwAnswer, generation: number): Promise<void> {
    let occupied = this.terminal?.occupied();
    if (occupied) {
      // Only one request is active at a time, so a second answer cannot reach
      // this point while one waits; a stale one is dropped rather than queued.
      this.held?.abandon();
      let abandon!: () => void;
      const abandoned = new Promise<false>((resolve) => { abandon = () => resolve(false); });
      const held = { answer, abandon };
      this.held = held;
      try {
        while (occupied) {
          // Each hold is a promise Side already owns: waiting on it needs no
          // timer, and the loop only turns again when Side took the terminal
          // back before Main could show the panel.
          if (!await Promise.race([occupied.then(() => true, () => true), abandoned])) return;
          if (generation !== this.generation) return;
          occupied = this.terminal?.occupied();
        }
      } finally {
        if (this.held === held) this.held = undefined;
      }
    }
    // With the browser up, the toast would post behind it and expire unseen.
    // The answer is already in the list, where it carries its own unread mark.
    if (this.browser) return;
    await this.presenter.notifyAnswered(ctx, answer);
  }

  /** Retire one request: it stops being current and takes its status down. */
  private finish(controller: AbortController): void {
    if (this.active === controller) {
      this.active = undefined;
      this.pending = undefined;
      this.changed();
    }
    this.clearStatus(controller);
  }

  private reset(): void {
    this.generation++;
    const controller = this.active;
    controller?.abort();
    this.active = undefined;
    this.pending = undefined;
    this.opening?.abandon();
    this.opening = undefined;
    if (controller) this.clearStatus(controller);
    this.held?.abandon();
    this.held = undefined;
    this.history = [];
    this.readKeys.clear();
    // Whatever browser is still on screen belongs to the session being replaced.
    this.browser?.abort();
    this.browser = undefined;
    this.changed();
    // The completion notice and its expiry timer belong to the runtime that
    // published them; a replaced session must not inherit either.
    this.presenter.dispose?.();
  }

  /** Only the controller that published the status may withdraw it. */
  private clearStatus(controller: AbortController): void {
    if (this.statusOwner?.controller !== controller) return;
    this.status.clear(this.statusOwner.ctx);
    this.statusOwner = undefined;
  }
}
