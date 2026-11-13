import { presentationPrototype } from "./presentation-owner.ts";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type TuiMouseEvent,
  type Component,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { onLeftClick } from "./clickable.ts";
import { claudeIndicatorPalette, RESET_FG } from "./cyber-style.ts";
import {
  userMessagePrototype,
  interactiveUserMessagePrototype,
  captureAppendedUserMessages,
  userMessageSourceCompat,
  TIMESTAMP_BINDING_PROBE,
  type AppendMessage,
  type TimestampOwner,
} from "./compat/user-message.ts";
import { replaceClipboardImagePaths } from "./image-marker.ts";
import { declareProbes, markBroken, markOk, type Probe } from "./internals.ts";
import type { TextOpener } from "./openers.ts";
import type { UserMessagesConfig } from "./types.ts";

// `UserMessageComponent.render` is part of Pi's exported class surface in
// Pi 1.2. Keep the runtime fail-open guard, but do not count a public member as
// a private-internals probe.
export const PROBES: Probe[] = [
  TIMESTAMP_BINDING_PROBE,
  {
    id: "user-message.text",
    needs: "UserMessageComponent 实例的 text 字段",
    breaks: "折叠用户消息仍可显示，但弹窗只能使用渲染后的文本",
  },
];

type RenderFn = (width: number) => string[];
type MouseFn = NonNullable<Component["handleMouse"]>;

interface PatchablePrototype {
  render: RenderFn;
  invalidate(): void;
  handleMouse?: MouseFn;
  [key: symbol]: unknown;
}

const PATCH_STATE = Symbol.for("pi-claude-transcript.user-message.patch");
const PATCH_OWNER = Symbol("pi-claude-transcript.user-message.owner");
const TRANSFORM_HOST = Symbol.for("pi-claude-transcript.user-message.host");
const TRANSFORM_HOST_LEASES = Symbol.for("pi-claude-transcript.user-message.host-leases.v1");
const USER_MESSAGE_TRANSFORMS_KEY = Symbol.for("ui-pack.user-message-render-transforms.v1");
/** Per-instance: what the last render folded away, and so what a click is for. */
const FOLDED = Symbol("pi-claude-transcript.user-message.folded");
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
interface PatchState {
  owner: symbol;
  original: RenderFn;
  originalMouse?: MouseFn;
  ownMouse: boolean;
  restoreTimestampBinding(): void;
}

type UserMessageTransform = (lines: string[]) => string[];

interface UserMessageTransformRegistry {
  version: 1;
  transforms: Map<symbol, UserMessageTransform>;
  hostOwner?: symbol;
}

function userMessageTransforms(create: boolean): UserMessageTransformRegistry | undefined {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const current = scope[USER_MESSAGE_TRANSFORMS_KEY];
  if (current === undefined && create) {
    const created: UserMessageTransformRegistry = { version: 1, transforms: new Map() };
    scope[USER_MESSAGE_TRANSFORMS_KEY] = created;
    return created;
  }
  if (
    typeof current !== "object"
    || current === null
    || (current as { version?: unknown }).version !== 1
    || !((current as { transforms?: unknown }).transforms instanceof Map)
  ) {
    return undefined;
  }
  return current as UserMessageTransformRegistry;
}

function applyUserMessageTransforms(lines: string[]): string[] {
  const registry = userMessageTransforms(false);
  if (!registry) return lines;
  let output = lines;
  for (const transform of [...registry.transforms.values()]) {
    try {
      const transformed = transform(output);
      if (Array.isArray(transformed) && transformed.every((line) => typeof line === "string")) {
        output = transformed;
      }
    } catch {
      // One cosmetic transform must not take down the transcript renderer.
    }
  }
  return output;
}

function claimUserMessageTransformHost(): (() => void) | undefined {
  const registry = userMessageTransforms(true);
  if (!registry || (registry.hostOwner !== undefined && registry.hostOwner !== TRANSFORM_HOST)) return undefined;
  // Main and child bundles share the dispatcher, but retire independently.
  // Keep the v1 host lease until the last CC presentation owner releases it.
  const scope = globalThis as Record<PropertyKey, unknown>;
  const leases = (scope[TRANSFORM_HOST_LEASES] ??= new WeakMap()) as WeakMap<object, Set<object>>;
  let owners = leases.get(registry);
  if (!owners) leases.set(registry, owners = new Set());
  const owner = {};
  owners.add(owner);
  registry.hostOwner = TRANSFORM_HOST;
  return () => {
    owners.delete(owner);
    if (owners.size === 0 && registry.hostOwner === TRANSFORM_HOST) delete registry.hostOwner;
  };
}

function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  const visuallyEmpty = (line: string) =>
    line
      .replace(ANSI_OSC_PATTERN, "")
      .replace(ANSI_CSI_PATTERN, "")
      .trim().length === 0;
  while (start < end && visuallyEmpty(lines[start] ?? "")) start++;
  while (end > start && visuallyEmpty(lines[end - 1] ?? "")) end--;
  return lines.slice(start, end);
}

/** Folding has to hide at least this many lines; the hint row costs one of them. */
const MIN_HIDDEN_LINES = 3;

/**
 * Keep the opening lines and say what was held back.
 *
 * The kept lines are the message's own first lines, not a filtered selection:
 * a request usually leads with what it is asking for, and the reader is
 * matching the box against what they typed. `maxLines` counts those lines
 * only — the hint that replaces the rest is chrome, not content. A message
 * that would hide fewer than three lines is drawn whole: trading one or two
 * lines for a hint row saves nothing, and a short message with a code block
 * would show only its fence.
 */
function foldBody(
  body: string[],
  maxLines: number,
): { lines: string[]; hidden: number } {
  if (maxLines <= 0 || body.length - maxLines < MIN_HIDDEN_LINES) return { lines: body, hidden: 0 };
  return { lines: body.slice(0, maxLines), hidden: body.length - maxLines };
}

/** The text the popup shows: what was typed, not what the transcript drew. */
function sourceText(component: unknown, fallback: string[]): string {
  const source = userMessageSourceCompat(component);
  if (!source.compatible) {
    markBroken("user-message.text", "实例上的 text 不是字符串");
    return fallback.join("\n");
  }
  markOk("user-message.text");
  return source.text && source.text.length > 0 ? source.text : fallback.join("\n");
}

function color(theme: Theme | undefined, name: string, text: string): string {
  if (!theme) return text;
  try {
    return theme.fg(name as never, text);
  } catch {
    return text;
  }
}

/**
 * The box title, in the working row's colour rather than the theme's `accent`.
 *
 * Taken straight from `claudeIndicatorPalette` instead of through a theme slot
 * for the same reason the spinner is: `accent` drives some sixty other sites,
 * so it cannot be moved for one of them. Reading the spinner's own base is
 * also what makes "the same colour" true by construction rather than by two
 * places happening to hold the same number — the palette is the single owner,
 * and `test/theme.test.ts` already ties it to the theme's `claude` var.
 *
 * This tracks the spinner under `working.style: "cyber"`, which is what draws a
 * coloured spinner at all; the plain style leaves the glyph to pi and there is
 * nothing to match.
 */
function paintClaude(text: string): string {
  return `${claudeIndicatorPalette.base}${text}${RESET_FG}`;
}

/** Local display time; the timestamp itself always comes from the session entry. */
export function formatUserMessageTimestamp(timestamp: string, today = new Date()): string | undefined {
  const sent = new Date(timestamp);
  if (!Number.isFinite(sent.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(sent.getHours())}:${pad(sent.getMinutes())}`;
  const sameDay = sent.getFullYear() === today.getFullYear() && sent.getMonth() === today.getMonth() && sent.getDate() === today.getDate();
  if (sameDay) return time;
  const date = `${pad(sent.getMonth() + 1)}-${pad(sent.getDate())}`;
  return `${sent.getFullYear() === today.getFullYear() ? date : `${sent.getFullYear()}-${date}`} ${time}`;
}

/**
 * The box is drawn with its border only.
 *
 * A `userMessageBg` fill wrapped each generated line, which left the fill
 * ending wherever the text ended instead of covering the row, and put a solid
 * block behind one message type while tool rows and thinking around it carry
 * no background at all. The border alone reads as the same box without either
 * problem.
 */

export function installCompactUserMessages(
  pi: ExtensionAPI,
  config: UserMessagesConfig,
  openText: TextOpener = () => false,
): () => void {
  if (!config.enabled || config.style === "native") return () => {};
  declareProbes(PROBES);
  const prototype = presentationPrototype(pi, userMessagePrototype<PatchablePrototype>(), "component");
  const existing = prototype[PATCH_STATE] as PatchState | undefined;
  if (existing?.owner === PATCH_OWNER) return () => {};
  if (existing) {
    // Do not stack another owner. The settings integration disables the previous
    // user-message extension before this extension is enabled.
    return () => {};
  }

  const original = prototype.render;
  const originalMouse = prototype.handleMouse;
  const ownMouse = Object.hasOwn(prototype, "handleMouse");
  const releaseTransformHost = claimUserMessageTransformHost();
  if (!releaseTransformHost) return () => {};
  let activeTheme: Theme | undefined;
  // One pre-transform frame per live component; native render still runs on hits.
  interface Frame {
    native: string[];
    width: number;
    theme: Theme | undefined;
    title: string;
    day: number;
    maxLines: number;
    horizontalPadding: number;
    verticalPadding: number;
    topMargin: number;
    lines: string[];
    hidden: boolean;
  }
  let frames = new WeakMap<object, Frame>();
  const originalInvalidate = prototype.invalidate;
  const ownInvalidate = Object.hasOwn(prototype, "invalidate");
  const invalidate = function(this: object): void {
    frames.delete(this);
    originalInvalidate.call(this);
  };
  prototype.invalidate = invalidate;
  const boundMessages = new WeakMap<object, AgentMessage>();
  let entryTimes = new WeakMap<object, string>();
  let uniqueTimes = new Map<number, string | undefined>();
  const syncEntryTimes = (ctx: ExtensionContext): void => {
    entryTimes = new WeakMap();
    uniqueTimes = new Map();
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        entryTimes.set(entry.message, entry.timestamp);
        const key = entry.message.timestamp;
        uniqueTimes.set(key, uniqueTimes.has(key) ? undefined : entry.timestamp);
      }
    } catch { /* A retired context cannot supply a trustworthy timestamp. */ }
  };
  const owner = presentationPrototype(pi, interactiveUserMessagePrototype<TimestampOwner>(), "mode");
  const originalAppend = owner.addMessageToChat;
  const patchedAppend: AppendMessage = function(message, options) {
    if (message.role !== "user") return originalAppend!.call(this, message, options);
    const capture = captureAppendedUserMessages(this, () => originalAppend!.call(this, message, options));
    if (!capture.available) {
      markBroken("user-message.timestampBinding", "chatContainer.children 不可用，未绑定发送时间");
      return;
    }
    for (const child of capture.components) boundMessages.set(child, message);
    markOk("user-message.timestampBinding");
  };
  if (typeof originalAppend === "function") owner.addMessageToChat = patchedAppend;
  else markBroken("user-message.timestampBinding", "addMessageToChat 不可用，未绑定发送时间");
  const restoreTimestampBinding = (): void => {
    if (owner.addMessageToChat === patchedAppend) owner.addMessageToChat = originalAppend;
  };
  prototype.render = function compactUserMessage(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth < 8) {
      frames.delete(this);
      return applyUserMessageTransforms(original.call(this, safeWidth));
    }
    const innerWidth = Math.max(
      1,
      safeWidth - 2 - config.horizontalPadding * 2,
    );
    let native: string[];
    try {
      native = original.call(this, innerWidth);
    } catch (error) {
      frames.delete(this);
      return applyUserMessageTransforms(original.call(this, safeWidth));
    }
    const message = boundMessages.get(this);
    const timestamp = message ? entryTimes.get(message) ?? uniqueTimes.get(message.timestamp) : undefined;
    const today = new Date();
    const day = today.getFullYear() * 10000 + today.getMonth() * 100 + today.getDate();
    const clock = timestamp ? formatUserMessageTimestamp(timestamp, today) : undefined;
    const titleText = ` ${config.title}${clock ? ` ${clock}` : ""} `;
    const cached = frames.get(this);
    if (cached && cached.width === safeWidth && cached.theme === activeTheme && cached.title === titleText && cached.day === day
      && cached.maxLines === config.maxLines && cached.horizontalPadding === config.horizontalPadding
      && cached.verticalPadding === config.verticalPadding && cached.topMargin === config.topMargin
      && cached.native.length === native.length && native.every((line, index) => line === cached.native[index])) {
      // Refresh popup text even on hits: source can change while visible native rows stay equal (e.g. images).
      (this as unknown as Record<symbol, unknown>)[FOLDED] = cached.hidden
        ? replaceClipboardImagePaths(sourceText(this, trimEmptyEdges(native)))
        : undefined;
      return applyUserMessageTransforms(cached.lines.slice());
    }
    let body = trimEmptyEdges(native);
    if (!body.length) body = [""];
    const folded = foldBody(body, config.maxLines);
    (this as unknown as Record<symbol, unknown>)[FOLDED] = folded.hidden > 0
      ? replaceClipboardImagePaths(sourceText(this, body))
      : undefined;
    if (folded.hidden > 0) {
      const hint = `… +${folded.hidden} lines · click to view`;
      body = [...folded.lines, color(activeTheme, "dim", hint)];
    }
    const title = truncateToWidth(titleText, safeWidth - 2, "");
    const titleWidth = visibleWidth(title);
    const top = `${color(activeTheme, "border", "╭")}${paintClaude(title)}${color(
      activeTheme,
      "border",
      `${"─".repeat(Math.max(0, safeWidth - titleWidth - 2))}╮`,
    )}`;
    const bottom = color(
      activeTheme,
      "border",
      `╰${"─".repeat(safeWidth - 2)}╯`,
    );
    const pad = " ".repeat(config.horizontalPadding);
    const vertical = Array.from({ length: config.verticalPadding }, () => "");
    const framed = [...vertical, ...body, ...vertical].map((line) => {
      const content = truncateToWidth(line, innerWidth, "", true);
      const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
      return `${color(activeTheme, "border", "│")}${pad}${content}${fill}${pad}${color(
        activeTheme,
        "border",
        "│",
      )}`;
    });
    const lines = [
      ...Array.from({ length: config.topMargin }, () => ""),
      top,
      ...framed,
      bottom,
    ];
    frames.set(this, { native: native.slice(), width: safeWidth, theme: activeTheme,
      title: titleText, day, maxLines: config.maxLines, horizontalPadding: config.horizontalPadding,
      verticalPadding: config.verticalPadding, topMargin: config.topMargin,
      lines, hidden: folded.hidden > 0 });
    // Neither transforms nor the caller may mutate our stored frame.
    return applyUserMessageTransforms(lines.slice());
  };
  /**
   * A folded box opens in the popup. A box that fits declines the click: there
   * is nothing behind it, and taking it would swallow a click Pi could use.
   */
  const openFolded = (component: unknown): boolean => {
    const text = (component as Record<symbol, unknown>)[FOLDED];
    if (typeof text !== "string") return false;
    return openText(config.title, text, { format: "plain", glyph: "❯", tone: "text" });
  };
  prototype.handleMouse = function userMessageMouse(event: TuiMouseEvent) {
    return onLeftClick(event, () => openFolded(this)) ?? originalMouse?.call(this, event);
  };
  const installed = { owner: PATCH_OWNER, original, originalMouse, ownMouse, restoreTimestampBinding } satisfies PatchState;
  prototype[PATCH_STATE] = installed;

  pi.on("session_shutdown", () => { frames = new WeakMap(); });
  pi.on("session_start", (_event, ctx) => {
    frames = new WeakMap();
    activeTheme = ctx.hasUI ? ctx.ui.theme : undefined;
    syncEntryTimes(ctx);
  });

  pi.on("message_start", (_event, ctx) => syncEntryTimes(ctx));
  pi.on("message_end", (_event, ctx) => syncEntryTimes(ctx));
  pi.on("session_tree", (_event, ctx) => syncEntryTimes(ctx));

  return () => {
    frames = new WeakMap();
    releaseTransformHost();
    const state = prototype[PATCH_STATE] as PatchState | undefined;
    if (state !== installed) return;
    state.restoreTimestampBinding();
    prototype.render = state.original;
    if (prototype.invalidate === invalidate) {
      if (ownInvalidate) prototype.invalidate = originalInvalidate;
      else delete (prototype as Partial<PatchablePrototype>).invalidate;
    }
    if (state.ownMouse) prototype.handleMouse = state.originalMouse;
    else delete prototype.handleMouse;
    delete prototype[PATCH_STATE];
    activeTheme = undefined;
  };
}
