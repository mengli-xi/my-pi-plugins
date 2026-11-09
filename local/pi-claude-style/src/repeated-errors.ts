import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ExtensionRunner, InteractiveMode, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Spacer,
  Text,
  stripTerminalSequences,
  type Component,
} from "@earendil-works/pi-tui";
import { onLeftClick } from "./clickable.ts";
import { presentationPrototype } from "./presentation-owner.ts";
import type { TextOpener } from "./openers.ts";

interface ErrorAttempt {
  message: string;
  timestamp: number;
}

interface ErrorCandidate {
  message: string;
  signature: string;
  summary: string;
  timestamp: number;
}

// Exact text matching: only these known per-attempt fields and wrappers vary.
const ERROR_NORMALIZATION = {
  prefixes: /^(?:Error:\s*|Retry failed after \d+ attempts?:\s*)+/iu,
  finalRetryPrefix: /^Retry failed after \d+ attempts?:\s*/iu,
  attempts: /(^|[\s(,;])(attempts=)\d+(?=$|[\s),;])/giu,
  requestIds: /(^|[\s(,;])((?:[a-z][a-z0-9]*_)*(?:request|log)_id=)[^,;\s()=]+(?=$|[\s),;])/giu,
  whitespace: /\s+/gu,
};
const UNSAFE_TERMINAL_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeErrorText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_TERMINAL_TEXT, "�");
}

export function sanitizeAssistantErrorPresentation(
  message: AssistantMessage,
): AssistantMessage {
  if (message.stopReason !== "error" || typeof message.errorMessage !== "string") {
    return message;
  }
  const errorMessage = sanitizeErrorText(message.errorMessage);
  return errorMessage === message.errorMessage ? message : { ...message, errorMessage };
}

function normalizeError(message: string): string {
  return sanitizeErrorText(message.replace(ERROR_NORMALIZATION.whitespace, " "))
    .trim()
    .replace(ERROR_NORMALIZATION.prefixes, "")
    .replace(ERROR_NORMALIZATION.attempts, "$1$2*")
    .replace(ERROR_NORMALIZATION.requestIds, "$1$2*")
    .trim();
}

function errorCandidate(
  message: string,
  timestamp: number,
): ErrorCandidate | undefined {
  const safeMessage = sanitizeErrorText(message);
  const text = sanitizeErrorText(message.trim().replace(ERROR_NORMALIZATION.prefixes, "")).trim();
  const signature = normalizeError(message);
  if (!signature) return undefined;
  const diagnosticStart = text.lastIndexOf(" (");
  const summary = diagnosticStart > 0 && text.endsWith(")")
    ? text.slice(0, diagnosticStart).trim()
    : text;
  return { message: safeMessage, signature, summary, timestamp };
}

function hasVisibleAssistantContent(message: AssistantMessage): boolean {
  return message.content.some((content) => {
    if (content.type === "toolCall") return true;
    if (content.type === "text") return content.text.trim().length > 0;
    if (content.type === "thinking") return content.thinking.trim().length > 0;
    return false;
  });
}

export class ErrorGroupComponent implements Component {
  readonly signature: string;
  private readonly summary: string;
  private readonly outputPad: number;
  private readonly getTheme: () => Theme | undefined;
  private readonly openText: TextOpener;
  private anchorChildren: Component[];
  private anchorSpacer: Component | undefined;
  private readonly attempts: ErrorAttempt[] = [];
  private finalNotice: ErrorAttempt | undefined;
  private aggregated = false;

  constructor(
    signature: string,
    summary: string,
    outputPad: number,
    getTheme: () => Theme | undefined,
    openText: TextOpener,
    anchorChildren: Component[],
  ) {
    this.signature = signature;
    this.summary = summary;
    this.outputPad = outputPad;
    this.getTheme = getTheme;
    this.openText = openText;
    this.anchorChildren = anchorChildren;
    this.captureAnchor(anchorChildren);
  }

  addAttempt(attempt: ErrorAttempt): void {
    this.attempts.push(attempt);
  }

  setFinalNotice(notice: ErrorAttempt): void {
    this.finalNotice = notice;
  }

  activate(): void {
    if (this.aggregated) return;
    this.aggregated = true;
    this.anchorChildren.splice(0, this.anchorChildren.length, ...this.anchorProjection());
  }

  project(identityIsAnchor: boolean, children: Component[]): boolean {
    if (!this.aggregated) {
      if (identityIsAnchor) this.captureAnchor(children);
      return false;
    }
    children.splice(0, children.length, ...(identityIsAnchor ? this.anchorProjection() : []));
    return true;
  }

  private captureAnchor(children: Component[]): void {
    this.anchorChildren = children;
    this.anchorSpacer = children.find((child) =>
      child instanceof Spacer || child.constructor?.name === "Spacer");
  }

  private anchorProjection(): Component[] {
    return this.anchorSpacer ? [this.anchorSpacer, this] : [this];
  }

  count(): number {
    return this.attempts.length;
  }

  details(): string {
    const sections = this.attempts.map((attempt, index) => [
      `Attempt ${index + 1} · ${new Date(attempt.timestamp).toISOString()}`,
      attempt.message,
    ].join("\n"));
    if (this.finalNotice) {
      sections.push([
        `Final · ${new Date(this.finalNotice.timestamp).toISOString()}`,
        this.finalNotice.message,
      ].join("\n"));
    }
    return sections.join("\n\n");
  }

  render(width: number): string[] {
    const theme = this.getTheme();
    const message = this.finalNotice
      ? `${this.summary} ${this.attempts.length}/${this.attempts.length}`
      : this.attempts.length > 1
        ? `${this.summary} ×${this.attempts.length}`
        : this.summary;
    const painted = theme ? theme.fg("error", message) : message;
    return new Text(painted, this.outputPad, 0).render(Math.max(0, Math.floor(width)));
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, () => this.open());
  }

  private open(): boolean {
    return this.openText(`Errors (${this.attempts.length})`, this.details(), {
      format: "plain",
      glyph: "✗",
      tone: "text",
    });
  }
}

/**
 * Runtime-local visual projection for consecutive retry errors. Session data,
 * provider retries and the original assistant messages remain untouched.
 */
export class RepeatedErrorCollapser {
  private readonly getTheme: () => Theme | undefined;
  private readonly openText: TextOpener;
  private readonly now: () => number;
  private activeRun = false;
  private current: ErrorGroupComponent | undefined;
  private seen = new WeakMap<object, {
    group: ErrorGroupComponent;
    anchor: boolean;
  }>();

  constructor(
    getTheme: () => Theme | undefined,
    openText: TextOpener,
    now: () => number = Date.now,
  ) {
    this.getTheme = getTheme;
    this.openText = openText;
    this.now = now;
  }

  startRun(): void {
    if (!this.activeRun) this.current = undefined;
    this.activeRun = true;
  }

  settleRun(): void {
    this.activeRun = false;
    this.current = undefined;
  }

  reset(): void {
    this.activeRun = false;
    this.current = undefined;
    this.seen = new WeakMap();
  }

  presentAssistant(
    identity: object,
    message: AssistantMessage,
    streaming: boolean,
    children: Component[] | undefined,
    outputPad: number | undefined,
  ): boolean {
    if (!children) return false;
    const seen = this.seen.get(identity);
    if (seen) return seen.group.project(seen.anchor, children);
    if (!this.activeRun) return false;
    if (streaming) {
      if (hasVisibleAssistantContent(message)) this.current = undefined;
      return false;
    }
    if (
      message.stopReason !== "error" ||
      hasVisibleAssistantContent(message) ||
      typeof message.errorMessage !== "string"
    ) {
      this.current = undefined;
      return false;
    }

    const candidate = errorCandidate(message.errorMessage, message.timestamp ?? this.now());
    if (!candidate) {
      this.current = undefined;
      return false;
    }

    let group = this.current;
    if (!group || group.signature !== candidate.signature) {
      group = new ErrorGroupComponent(
        candidate.signature,
        candidate.summary,
        outputPad ?? 1,
        this.getTheme,
        this.openText,
        children,
      );
      this.current = group;
    }
    group.addAttempt(candidate);
    const anchor = group.count() === 1;
    this.seen.set(identity, { group, anchor });
    if (anchor) return false;
    group.activate();
    children.splice(0, children.length);
    return true;
  }

  absorbFinalNotice(message: string): boolean {
    if (!this.activeRun || !this.current || !ERROR_NORMALIZATION.finalRetryPrefix.test(message)) return false;
    const candidate = errorCandidate(message, this.now());
    if (
      !candidate ||
      candidate.signature !== this.current.signature ||
      this.current.count() < 2
    ) {
      this.current = undefined;
      return false;
    }
    this.current.setFinalNotice({
      message: candidate.message,
      timestamp: candidate.timestamp,
    });
    this.current.activate();
    return true;
  }

  breakSequence(): void {
    this.current = undefined;
  }
}

type ShowError = (this: unknown, message: string) => void;

/**
 * Pi ends a failed retry run with one more `showError` that repeats the last
 * assistant error, which the collapsed row already counts: absorb it into that row
 * as its `N/N` final state. Every other notice is Pi's own. `showError` is a
 * public InteractiveMode method. Extension info/warning notifications break
 * the sequence through public setUIContext/notify; no private showStatus seam
 * is used, so Pi-internal status notices are outside this boundary.
 */
export function installFinalNoticeAbsorption(
  pi: ExtensionAPI,
  collapser: RepeatedErrorCollapser,
): () => void {
  const prototype = presentationPrototype(
    pi,
    InteractiveMode.prototype as unknown as { showError?: ShowError },
    "mode",
  );
  const original = prototype.showError;
  if (typeof original === "function") prototype.showError = function absorbFinalNotice(message: string): void {
    // Pi repaints right after this notice, so an absorbed one needs no render.
    if (collapser.absorbFinalNotice(message)) return;
    collapser.breakSequence();
    original.call(this, message);
  };
  const runner = presentationPrototype(pi, ExtensionRunner.prototype, "runner");
  const setUIContext = runner.setUIContext;
  let live = true;
  if (typeof setUIContext === "function") runner.setUIContext = function (ui, mode) {
    return setUIContext.call(this, ui ? {
      ...ui,
      notify(message, type) {
        if (live && (type === undefined || type === "info" || type === "warning")) {
          collapser.breakSequence();
        }
        ui.notify(message, type);
      },
    } : ui, mode);
  };
  return () => {
    live = false;
    if (typeof original === "function") prototype.showError = original;
    if (typeof setUIContext === "function") runner.setUIContext = setUIContext;
  };
}
