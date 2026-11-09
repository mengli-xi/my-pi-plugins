import { bindPresentationReceiver, openPresentationText, registerPresentationOpener, withPresentationRequest } from "./presentation-owner.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type {
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import { onLeftClick } from "./clickable.ts";
import { colorWithMutedEllipses, truncateWithMutedEllipsis } from "./ellipsis.ts";
import {
  AGENT_SKILL_READ_ENTRY_TYPE,
  CTX_STATUS_CUSTOM_ENTRY_TYPE,
  CUSTOM_ENTRY_PRESENTATIONS_KEY,
  LEGACY_SKILL_BINDING_ENTRY_TYPE,
  PROCESS_EVENT_CUSTOM_ENTRY_TYPE,
  SKILL_BINDING_ENTRY_TYPE,
  SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE,
} from "./integration-contracts.ts";
import type { Disposable } from "./lifecycle.ts";
import type { TextOpener } from "./openers.ts";

interface CustomEntryPresentationProvider {
  version: 1;
  owner: symbol;
  render(input: unknown): Component | undefined;
}

interface CustomEntryPresentationRegistry {
  version: 1;
  providers: Map<string, CustomEntryPresentationProvider>;
}

interface ProcessEventPresentationRequest {
  version: 1;
  customType: typeof PROCESS_EVENT_CUSTOM_ENTRY_TYPE;
  data: {
    version: 2;
    kind?: "terminal" | "watch-match" | "matcher-error";
    text: string;
    process: { name: string };
    terminal?: {
      outcome: "succeeded" | "failed" | "stopped" | "killed" | "crashed";
      cause: "completed" | "exit-code" | "signal" | "runtime-error" | "stopped" | "killed" | "timeout";
      durationMs: number;
      exitCode?: number;
      signal?: string;
      timeoutMs?: number;
    };
    stdout?: string[];
    stderr?: string[];
    details?: Record<string, unknown>;
  };
  options: { expanded?: unknown };
  theme: Theme;
}

interface LoadedSkillPresentationRequest {
  version: 1;
  customType:
    | typeof SKILL_BINDING_ENTRY_TYPE
    | typeof LEGACY_SKILL_BINDING_ENTRY_TYPE
    | typeof AGENT_SKILL_READ_ENTRY_TYPE;
  skills: Array<{ name: string; path: string; contents: string }>;
  options: { expanded?: unknown };
  theme: Theme;
}

interface SubagentCompletionPresentationRequest {
  version: 1;
  customType: typeof SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE;
  completion: {
    taskPath: string;
    outcome: string;
    reason: string;
    summary: string;
    result: string;
    resultTruncated: boolean;
    originalResultBytes?: number;
    renderedResultBytes?: number;
    totalTokens?: number;
    durationMs?: number;
  };
  options: { expanded?: unknown; outputPad?: unknown };
  theme: Theme;
}

interface CtxStatusPresentation {
  title: string;
  heading: string;
  body: string;
  summary: string;
}

interface CtxStatusPresentationRequest {
  version: 1;
  customType: typeof CTX_STATUS_CUSTOM_ENTRY_TYPE;
  data: { level?: unknown };
  presentation: CtxStatusPresentation;
  options: { expanded?: unknown };
  theme: Theme;
}

type CtxStatusLevel = "info" | "success" | "warning" | "error";

function processGlobals(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

function registry(): CustomEntryPresentationRegistry | undefined {
  const globals = processGlobals();
  const existing = globals[CUSTOM_ENTRY_PRESENTATIONS_KEY];
  if (existing === undefined) {
    const created: CustomEntryPresentationRegistry = {
      version: 1,
      providers: new Map(),
    };
    globals[CUSTOM_ENTRY_PRESENTATIONS_KEY] = created;
    return created;
  }
  if (
    typeof existing !== "object" || existing === null ||
    (existing as { version?: unknown }).version !== 1 ||
    !((existing as { providers?: unknown }).providers instanceof Map)
  ) {
    return undefined;
  }
  return existing as CustomEntryPresentationRegistry;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requestFrom(input: unknown): CtxStatusPresentationRequest | undefined {
  if (!isStringRecord(input)) return undefined;
  if (input.version !== 1 || input.customType !== CTX_STATUS_CUSTOM_ENTRY_TYPE) {
    return undefined;
  }
  const data = input.data;
  const presentation = input.presentation;
  const options = input.options;
  const theme = input.theme;
  if (
    !isStringRecord(data) || !isStringRecord(presentation) ||
    !isStringRecord(options) || !isStringRecord(theme) ||
    typeof theme.fg !== "function"
  ) {
    return undefined;
  }
  for (const key of ["title", "heading", "body", "summary"] as const) {
    if (typeof presentation[key] !== "string") return undefined;
  }
  return {
    version: 1,
    customType: CTX_STATUS_CUSTOM_ENTRY_TYPE,
    data,
    presentation: presentation as unknown as CtxStatusPresentation,
    options,
    theme: theme as unknown as Theme,
  };
}

function processEventRequestFrom(input: unknown): ProcessEventPresentationRequest | undefined {
  if (!isStringRecord(input)) return undefined;
  if (input.version !== 1 || input.customType !== PROCESS_EVENT_CUSTOM_ENTRY_TYPE) return undefined;
  const data = input.data;
  const options = input.options;
  const theme = input.theme;
  if (
    !isStringRecord(data) || data.version !== 2 || typeof data.text !== "string" ||
    !isStringRecord(data.process) || typeof data.process.name !== "string" ||
    !isStringRecord(options) || !isStringRecord(theme) || typeof theme.fg !== "function" ||
    (data.stdout !== undefined && !Array.isArray(data.stdout)) ||
    (data.stderr !== undefined && !Array.isArray(data.stderr)) ||
    (data.terminal !== undefined && !isStringRecord(data.terminal))
  ) return undefined;
  if (isStringRecord(data.terminal)) {
    const causes = ["completed", "exit-code", "signal", "runtime-error", "stopped", "killed", "timeout"];
    const outcomes = ["succeeded", "failed", "stopped", "killed", "crashed"];
    if (
      !causes.includes(String(data.terminal.cause)) ||
      !outcomes.includes(String(data.terminal.outcome)) ||
      typeof data.terminal.durationMs !== "number" || !Number.isFinite(data.terminal.durationMs) ||
      (data.terminal.exitCode !== undefined && typeof data.terminal.exitCode !== "number") ||
      (data.terminal.signal !== undefined && typeof data.terminal.signal !== "string") ||
      (data.terminal.timeoutMs !== undefined && typeof data.terminal.timeoutMs !== "number")
    ) return undefined;
  }
  return input as unknown as ProcessEventPresentationRequest;
}

function subagentCompletionRequestFrom(input: unknown): SubagentCompletionPresentationRequest | undefined {
  if (!isStringRecord(input) || input.version !== 1 || input.customType !== SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE) return undefined;
  const completion = input.completion;
  if (
    !isStringRecord(completion) || typeof completion.taskPath !== "string" ||
    typeof completion.outcome !== "string" || typeof completion.reason !== "string" ||
    typeof completion.summary !== "string" || typeof completion.result !== "string" ||
    typeof completion.resultTruncated !== "boolean" || !isStringRecord(input.options) ||
    (input.options.outputPad !== undefined && typeof input.options.outputPad !== "number") ||
    !isStringRecord(input.theme) || typeof input.theme.fg !== "function" ||
    (completion.originalResultBytes !== undefined && typeof completion.originalResultBytes !== "number") ||
    (completion.renderedResultBytes !== undefined && typeof completion.renderedResultBytes !== "number") ||
    (completion.totalTokens !== undefined && typeof completion.totalTokens !== "number") ||
    (completion.durationMs !== undefined && typeof completion.durationMs !== "number")
  ) return undefined;
  return input as unknown as SubagentCompletionPresentationRequest;
}

function loadedSkillRequestFrom(input: unknown): LoadedSkillPresentationRequest | undefined {
  if (!isStringRecord(input) || input.version !== 1) return undefined;
  if (
    input.customType !== SKILL_BINDING_ENTRY_TYPE
    && input.customType !== LEGACY_SKILL_BINDING_ENTRY_TYPE
    && input.customType !== AGENT_SKILL_READ_ENTRY_TYPE
  ) return undefined;
  if (!Array.isArray(input.skills) || input.skills.length === 0) return undefined;
  if (!input.skills.every((skill) => (
    isStringRecord(skill)
    && typeof skill.name === "string"
    && typeof skill.path === "string"
    && typeof skill.contents === "string"
  ))) return undefined;
  if (
    !isStringRecord(input.options) || !isStringRecord(input.theme)
    || typeof input.theme.fg !== "function"
  ) return undefined;
  return input as unknown as LoadedSkillPresentationRequest;
}

function levelOf(value: unknown): CtxStatusLevel {
  return value === "success" || value === "warning" || value === "error"
    ? value
    : "info";
}

function glyphFor(level: CtxStatusLevel): string {
  switch (level) {
    case "success": return "✓";
    case "warning": return "!";
    case "error": return "×";
    default: return "•";
  }
}

function glyphTone(level: CtxStatusLevel): ThemeColor {
  switch (level) {
    case "success": return "success";
    case "warning": return "warning";
    case "error": return "error";
    default: return "accent";
  }
}

export class LoadedSkillPresentationComponent implements Component {
  private readonly request: LoadedSkillPresentationRequest;
  private readonly openText: TextOpener;

  constructor(request: LoadedSkillPresentationRequest, openText: TextOpener) {
    this.request = request;
    this.openText = openText;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    return this.request.skills.map((skill) => truncateWithMutedEllipsis(
      this.request.theme.fg("accent", ` ✦ Loaded skill ${skill.name}`),
      safeWidth,
      this.request.theme,
    ));
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, (row) => this.open(row));
  }

  private open(row: number): boolean {
    const skill = this.request.skills[row];
    if (!skill) return false;
    return this.openText(`Skill: ${skill.name}`, skill.contents, {
      format: "markdown",
      glyph: "✦",
      tone: "text",
    });
  }
}

/** Legacy ctx-status presentation for old sessions; no Magic Context runtime dependency. */
export class CtxStatusPresentationComponent implements Component {
  private readonly request: CtxStatusPresentationRequest;
  private readonly openText: TextOpener;

  constructor(request: CtxStatusPresentationRequest, openText: TextOpener) {
    this.request = request;
    this.openText = openText;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const { data, options, presentation, theme } = this.request;
    const level = levelOf(data.level);
    const glyph = theme.fg(glyphTone(level), glyphFor(level));
    const command = theme.fg("customMessageLabel", presentation.title);
    const separator = theme.fg("dim", " · ");
    const summary = colorWithMutedEllipses(
      theme,
      "customMessageText",
      presentation.summary,
    );
    const row = truncateWithMutedEllipsis(
      `${glyph} ${command}${separator}${summary}`,
      safeWidth,
      theme,
    );
    if (!options.expanded) return [row];
    const body = new Text(
      theme.fg("customMessageText", presentation.body),
      2,
      0,
    );
    return [row, ...body.render(safeWidth)];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, (row) => this.open(row));
  }

  private open(_row: number): boolean {
    const { heading, body } = this.request.presentation;
    return this.openText(heading, body, {
      glyph: "▸",
      tone: "text",
    });
  }
}

export class SubagentCompletionPresentationComponent implements Component {
  private readonly request: SubagentCompletionPresentationRequest;
  private readonly openText: TextOpener;

  constructor(request: SubagentCompletionPresentationRequest, openText: TextOpener) {
    this.request = request;
    this.openText = openText;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const { completion, theme } = this.request;
    const success = completion.outcome === "completed";
    const interrupted = completion.outcome === "interrupted";
    const blocked = completion.outcome === "blocked";
    const glyph = success ? "✓" : interrupted ? "◆" : blocked ? "!" : "✗";
    const tone: ThemeColor = success ? "success" : interrupted || blocked ? "warning" : "error";
    const metadata = [
      completion.outcome,
      completion.reason,
      completion.totalTokens === undefined ? undefined : `${compactCount(completion.totalTokens)} tokens`,
      completion.durationMs === undefined ? undefined : formatProcessDuration(completion.durationMs),
    ].filter(Boolean).join(" · ");
    const meta = metadata ? ` ${theme.fg("dim", metadata)}` : "";
    const padding = " ".repeat(Math.max(0, Math.floor(Number(this.request.options.outputPad) || 0)));
    return [truncateWithMutedEllipsis(
      `${padding}${theme.fg(tone, glyph)} ${theme.fg("accent", `Agent '${completion.taskPath}'`)}${meta}`,
      safeWidth,
      theme,
    )];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, (row) => this.open(row));
  }

  private open(_row: number): boolean {
    const { completion } = this.request;
    const truncation = completion.resultTruncated
      ? `\n\n_Result truncated${completion.renderedResultBytes === undefined || completion.originalResultBytes === undefined ? "." : `: ${completion.renderedResultBytes.toLocaleString()} of ${completion.originalResultBytes.toLocaleString()} bytes.`}_`
      : "";
    const body = `## Summary\n\n${completion.summary}\n\n## Result\n\n${completion.result || "No result text."}${truncation}`;
    return this.openText(`Agent ${completion.outcome}: ${completion.taskPath}`, body, {
      format: "markdown",
      glyph: completion.outcome === "completed" ? "✓" : completion.outcome === "interrupted" ? "◆" : completion.outcome === "blocked" ? "!" : "✗",
      tone: "text",
    });
  }
}

function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/u, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

const ANSI_DIM = "\x1b[2m";
const ANSI_NORMAL_INTENSITY = "\x1b[22m";

function formatProcessDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}

function terminalTone(cause: NonNullable<ProcessEventPresentationRequest["data"]["terminal"]>["cause"]): ThemeColor {
  if (cause === "completed") return "success";
  if (cause === "timeout") return "warning";
  if (cause === "stopped") return "muted";
  return "error";
}

function terminalStatus(terminal: NonNullable<ProcessEventPresentationRequest["data"]["terminal"]>): string {
  const duration = terminal.durationMs > 0 ? ` after ${formatProcessDuration(terminal.durationMs)}` : "";
  switch (terminal.cause) {
    case "completed": return `succeeded${duration}`;
    case "exit-code": return `failed${duration} · exit code ${terminal.exitCode ?? "unknown"}`;
    case "signal": return `failed${duration} · signal ${terminal.signal ?? "unknown"}`;
    case "timeout": return `timed out${duration}${terminal.timeoutMs === undefined ? "" : ` · limit ${formatProcessDuration(terminal.timeoutMs)}`}`;
    case "stopped": return `stopped${duration}`;
    case "killed": return `was killed${duration}${terminal.signal ? ` · ${terminal.signal}` : ""}`;
    default: return `crashed${duration}`;
  }
}

function dimSemantic(theme: Theme, tone: ThemeColor, text: string): string {
  return `${ANSI_DIM}${theme.fg(tone, text)}${ANSI_NORMAL_INTENSITY}`;
}

/** CC Style's visual treatment for process lifecycle messages. */
export class ProcessEventPresentationComponent implements Component {
  private readonly request: ProcessEventPresentationRequest;
  private readonly openText: TextOpener;

  constructor(request: ProcessEventPresentationRequest, openText: TextOpener) {
    this.request = request;
    this.openText = openText;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const { data, options, theme } = this.request;
    const terminal = data.kind === "terminal" ? data.terminal : undefined;
    const text = terminal
      ? `${theme.fg("muted", `  Process '${data.process.name}' `)}${dimSemantic(theme, terminalTone(terminal.cause), terminalStatus(terminal))}`
      : theme.fg("muted", `  ${data.text}`);
    const row = truncateWithMutedEllipsis(text, safeWidth, theme);
    if (!options.expanded) return [row];
    const lines: string[] = [];
    if (data.stdout?.length) {
      lines.push(...data.stdout.map((line, index) => `  ${index === 0 ? "stdout: " : ""}${line}`));
    }
    if (data.stderr?.length) {
      lines.push(...data.stderr.map((line, index) => `  ${index === 0 ? "stderr: " : ""}${line}`));
    }
    if (data.details) lines.push(`  ${JSON.stringify(data.details)}`);
    return [row, ...new Text(theme.fg("customMessageText", lines.join("\n")), 0, 0).render(safeWidth)];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, (row) => this.open(row));
  }

  private open(_row: number): boolean {
    const { data } = this.request;
    const body = [
      ...(data.stdout?.length ? ["stdout:", ...data.stdout] : []),
      ...(data.stderr?.length ? ["stderr:", ...data.stderr] : []),
      ...(data.details ? [JSON.stringify(data.details, null, 2)] : []),
    ].join("\n");
    return this.openText(`Process '${data.process.name}'`, body || data.text, {
      glyph: "▸",
      tone: "text",
    });
  }
}

function createCtxStatusComponent(
  input: unknown,
  openText: TextOpener,
): Component | undefined {
  const request = requestFrom(input);
  return request
    ? new CtxStatusPresentationComponent(request, openText)
    : undefined;
}

/**
 * Claim the ctx-status presentation slot for one CC Style runtime. A stale
 * runtime only removes its own provider, so replacement teardown cannot erase
 * a newer factory's registration.
 */
function installProvider(
  customType: string,
  render: (input: unknown, opener?: TextOpener) => Component | undefined,
  scoped = false,
): Disposable {
  const shared = registry();
  if (!shared) return { dispose() {} };
  const refsKey = Symbol.for("pi.claude-style.custom-entry-owner-refs.v1");
  const refs = (processGlobals()[refsKey] ??= new WeakMap()) as WeakMap<object, number>;
  const existing = shared.providers.get(customType);
  if (scoped && existing && refs.has(existing)) {
    refs.set(existing, refs.get(existing)! + 1);
    return { dispose: () => {
      const remaining = refs.get(existing)! - 1;
      refs.set(existing, remaining);
      if (!remaining && shared.providers.get(customType) === existing) shared.providers.delete(customType);
    } };
  }
  const provider: CustomEntryPresentationProvider = {
    version: 1,
    owner: Symbol(`pi-claude-style.${customType}-presentation.owner`),
    render: scoped ? (input) => withPresentationRequest(input, () => {
      let component: Component | undefined;
      component = render(input, (...args) => component ? openPresentationText(component, ...args) : false);
      if (component) bindPresentationReceiver(component);
      return component;
    }) : render,
  };
  if (scoped) refs.set(provider, 1);
  shared.providers.set(customType, provider);
  return {
    dispose: () => {
      if (scoped) {
        const remaining = refs.get(provider)! - 1;
        refs.set(provider, remaining);
        if (remaining) return;
      }
      if (shared.providers.get(customType) === provider) shared.providers.delete(customType);
    },
  };
}

export function installCustomEntryPresentationProviders(
  openText: TextOpener,
  pi?: ExtensionAPI,
): Disposable {
  const scoped = !!pi && registerPresentationOpener(pi, openText);
  // Shared providers outlive individual runtimes; only the owner registry may
  // retain a live opener. Scoped renderers always receive an instance opener.
  const defaultOpener: TextOpener = scoped ? () => false : openText;
  const ctxStatus = installProvider(
    CTX_STATUS_CUSTOM_ENTRY_TYPE,
    (input, opener = defaultOpener) => createCtxStatusComponent(input, opener),
    scoped,
  );
  const processEvent = installProvider(
    PROCESS_EVENT_CUSTOM_ENTRY_TYPE,
    (input, opener = defaultOpener) => {
      const request = processEventRequestFrom(input);
      return request ? new ProcessEventPresentationComponent(request, opener) : undefined;
    },
    scoped,
  );
  const subagentCompletion = installProvider(
    SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE,
    (input, opener = defaultOpener) => {
      const request = subagentCompletionRequestFrom(input);
      return request ? new SubagentCompletionPresentationComponent(request, opener) : undefined;
    },
    scoped,
  );
  const loadedSkillProviders = [
    SKILL_BINDING_ENTRY_TYPE,
    LEGACY_SKILL_BINDING_ENTRY_TYPE,
    AGENT_SKILL_READ_ENTRY_TYPE,
  ].map((customType) => installProvider(
    customType,
    (input, opener = defaultOpener) => {
      const request = loadedSkillRequestFrom(input);
      return request ? new LoadedSkillPresentationComponent(request, opener) : undefined;
    },
    scoped,
  ));
  return {
    dispose: async () => {
      for (const provider of loadedSkillProviders.reverse()) await provider.dispose();
      await subagentCompletion.dispose();
      await processEvent.dispose();
      await ctxStatus.dispose();
    },
  };
}

export function installCtxStatusPresentationProvider(
  openText: TextOpener,
): Disposable {
  return installProvider(
    CTX_STATUS_CUSTOM_ENTRY_TYPE,
    (input) => createCtxStatusComponent(input, openText),
  );
}
