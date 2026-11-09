import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EntryRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  LEGACY_SKILL_BINDING_ENTRY_TYPE,
  SKILL_BINDING_ENTRY_TYPE,
  type InvocationSnapshot,
} from "./invocations.ts";
import {
  MAX_SKILL_NAME_BYTES,
  MAX_SKILL_PATH_BYTES,
  truncateUtf8,
  type LoadedSkill,
  type SkillRef,
} from "./skills.ts";

export const AGENT_SKILL_READ_ENTRY_TYPE = "pi-skills:agent-read-v1";

/** Copied synchronous presentation contract owned by pi-claude-style. */
export const CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION =
  "pi.claude-style.custom-entry-presentations.v1";
const CUSTOM_ENTRY_PRESENTATIONS_KEY = Symbol.for(
  CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION,
);

export interface AgentSkillReadSnapshot {
  version: 1;
  source: "agent-read";
  toolCallId: string;
  skill: LoadedSkill;
}

interface LoadedSkillPresentationRequest {
  version: 1;
  customType: string;
  skills: LoadedSkill[];
  options: { expanded: boolean };
  theme: Theme;
}

interface PresentationProvider {
  version: 1;
  render(input: unknown): Component | undefined;
}

/** Pi fullscreen delivers clicks through `handleMouse`; the delegate passes them on. */
interface ClickableComponent extends Component {
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

interface ReadInput {
  parentToolCallId?: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface MatchedRead {
  parentToolCallId?: string;
  skill: SkillRef;
  pathKey: string;
  startLine: number;
  limit?: number;
}

interface ReadProgress {
  contents: string;
  totalLines: number;
  ranges: Array<{ start: number; end: number }>;
}

interface ReadCompletion {
  parentToolCallId?: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

type ToolResultIdentity = Pick<Extract<AgentMessage, { role: "toolResult" }>, "toolCallId" | "toolName" | "nestedCalls">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLoadedSkill(value: unknown): value is LoadedSkill {
  if (!isRecord(value)) return false;
  return typeof value.name === "string"
    && typeof value.path === "string"
    && typeof value.contents === "string"
    && value.truncated !== true;
}

export function loadedSkills(customType: string, data: unknown): LoadedSkill[] {
  if (!isRecord(data) || data.version !== 1) return [];
  if (
    customType === SKILL_BINDING_ENTRY_TYPE
    || customType === LEGACY_SKILL_BINDING_ENTRY_TYPE
  ) {
    const snapshot = data as Partial<InvocationSnapshot>;
    return Array.isArray(snapshot.skills)
      ? snapshot.skills.filter(isLoadedSkill)
      : [];
  }
  if (customType === AGENT_SKILL_READ_ENTRY_TYPE) {
    const snapshot = data as Partial<AgentSkillReadSnapshot>;
    return snapshot.source === "agent-read"
        && typeof snapshot.toolCallId === "string"
        && isLoadedSkill(snapshot.skill)
      ? [snapshot.skill]
      : [];
  }
  return [];
}

function presentationProvider(customType: string): PresentationProvider["render"] | undefined {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const registry = globals[CUSTOM_ENTRY_PRESENTATIONS_KEY];
  if (
    !isRecord(registry) || registry.version !== 1
    || !(registry.providers instanceof Map)
  ) return undefined;
  const provider = registry.providers.get(customType);
  if (
    !isRecord(provider) || provider.version !== 1
    || typeof provider.render !== "function"
  ) return undefined;
  return provider.render as PresentationProvider["render"];
}

/** Resolve on every operation so historical rows adopt a late CC Style runtime. */
function presentationDelegate(
  customType: string,
  request: LoadedSkillPresentationRequest,
  fallback: Component,
): ClickableComponent {
  let provider: PresentationProvider["render"] | undefined;
  let component: Component | undefined;
  let failedProvider: PresentationProvider["render"] | undefined;

  const current = (): Component => {
    const next = presentationProvider(customType);
    if (!next || next === failedProvider) {
      provider = next;
      component = undefined;
      return fallback;
    }
    if (next !== provider) {
      provider = next;
      component = undefined;
      try {
        component = next(request);
      } catch {
        failedProvider = next;
      }
    }
    return component ?? fallback;
  };

  return {
    render(width): string[] {
      const selected = current();
      try {
        return selected.render(width);
      } catch {
        if (selected !== fallback) {
          failedProvider = provider;
          component = undefined;
          try { return fallback.render(width); } catch { /* fail open */ }
        }
        return [];
      }
    },
    invalidate(): void {
      try { current().invalidate?.(); } catch { /* presentation is optional */ }
    },
    handleInput(data): void {
      try { current().handleInput?.(data); } catch { /* presentation is optional */ }
    },
    handleMouse(event): TuiMouseEventResult | undefined {
      try { return current().handleMouse?.(event); } catch { return undefined; }
    },
  };
}

class LoadedSkillFallback implements Component {
  private readonly skills: LoadedSkill[];
  private readonly theme: Theme;

  constructor(skills: LoadedSkill[], theme: Theme) {
    this.skills = skills;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    return this.skills.map((skill) => this.theme.fg(
      "accent",
      truncateToWidth(` ✦ Loaded skill ${skill.name}`, safeWidth, "…"),
    ));
  }

  invalidate(): void {}
}

export function createLoadedSkillsRenderer(customType: string): EntryRenderer<unknown> {
  return (entry, options, theme) => {
    const skills = loadedSkills(customType, entry.data);
    if (skills.length === 0) return undefined;
    const fallback = new LoadedSkillFallback(skills, theme);
    return presentationDelegate(customType, {
      version: 1,
      customType,
      skills,
      options: { expanded: options.expanded === true },
      theme,
    }, fallback);
  };
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function localPath(filePath: string): string {
  const normalized = filePath.replace(UNICODE_SPACES, " ");
  const withoutAt = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  const expanded = expandHome(withoutAt);
  if (!expanded.startsWith("file://")) return expanded;
  try {
    return fileURLToPath(expanded);
  } catch {
    return expanded;
  }
}

function canonicalPath(filePath: string, cwd: string): string {
  const local = localPath(filePath);
  const absolute = isAbsolute(local) ? resolve(local) : resolve(cwd, local);
  const nfd = absolute.normalize("NFD");
  const variants = [
    absolute,
    absolute.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    absolute.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
  for (const variant of variants) {
    try {
      return realpathSync.native(variant);
    } catch {
      // Match Pi read's macOS path fallbacks before retaining the unresolved path.
    }
  }
  return absolute;
}

function textResult(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const blocks = result.content.filter((part): part is { type: "text"; text: string } => (
    isRecord(part) && part.type === "text" && typeof part.text === "string"
  ));
  return blocks.length > 0 ? blocks.map((part) => part.text).join("\n") : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function visibleRange(
  read: MatchedRead,
  result: unknown,
  contents: string,
): { start: number; end: number } | undefined {
  const output = textResult(result);
  if (output === undefined) return undefined;
  const lines = contents.split("\n");
  if (read.startLine > lines.length) return undefined;

  const details = isRecord(result) && isRecord(result.details)
    ? result.details
    : undefined;
  const truncation = details && isRecord(details.truncation)
    ? details.truncation
    : undefined;
  if (truncation?.truncated === true) {
    const outputLines = positiveInteger(truncation.outputLines);
    if (outputLines === undefined) return undefined;
    const expected = lines.slice(read.startLine - 1, read.startLine - 1 + outputLines).join("\n");
    if (output !== expected && !output.startsWith(`${expected}\n\n[`)) return undefined;
    return {
      start: read.startLine,
      end: Math.min(lines.length, read.startLine + outputLines - 1),
    };
  }

  const end = read.limit === undefined
    ? lines.length
    : Math.min(lines.length, read.startLine + read.limit - 1);
  const expected = lines.slice(read.startLine - 1, end).join("\n");
  if (output !== expected && !output.startsWith(`${expected}\n\n[`)) return undefined;
  return { start: read.startLine, end };
}

function addRange(
  ranges: Array<{ start: number; end: number }>,
  added: { start: number; end: number },
): Array<{ start: number; end: number }> {
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of [...ranges, added].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function coversFile(progress: ReadProgress): boolean {
  return progress.ranges.length === 1
    && progress.ranges[0]?.start === 1
    && progress.ranges[0].end >= progress.totalLines;
}

/** Holds successful skill reads until turn_end has persisted their tool results. */
export class AgentSkillReadTracker {
  private readonly loadContents: (path: string) => Promise<string>;
  private readonly candidates = new Map<string, MatchedRead>();
  private readonly progress = new Map<string, ReadProgress>();
  private readonly completed = new Map<string, {
    snapshot: AgentSkillReadSnapshot;
    parentToolCallId?: string;
  }>();

  constructor(loadContents: (path: string) => Promise<string> = (path) => readFile(path, "utf8")) {
    this.loadContents = loadContents;
  }

  match(event: ReadInput, cwd: string, catalog: readonly SkillRef[]): void {
    if (event.toolName !== "read" || !isRecord(event.args)) return;
    const rawPath = event.args.path;
    if (typeof rawPath !== "string") return;
    const offset = event.args.offset === undefined ? 1 : positiveInteger(event.args.offset);
    const limit = event.args.limit === undefined ? undefined : positiveInteger(event.args.limit);
    if (offset === undefined || (event.args.limit !== undefined && limit === undefined)) return;
    const pathKey = canonicalPath(rawPath, cwd);
    const skill = catalog.find((candidate) => canonicalPath(candidate.path, cwd) === pathKey);
    if (skill) {
      this.candidates.set(event.toolCallId, {
        parentToolCallId: event.parentToolCallId,
        skill,
        pathKey,
        startLine: offset,
        ...(limit === undefined ? {} : { limit }),
      });
    }
  }

  async finish(event: ReadCompletion): Promise<void> {
    const matched = this.candidates.get(event.toolCallId);
    this.candidates.delete(event.toolCallId);
    if (!matched || event.toolName !== "read" || event.isError
      || matched.parentToolCallId !== event.parentToolCallId) return;

    let contents: string;
    try {
      contents = await this.loadContents(matched.skill.path);
    } catch {
      this.progress.delete(matched.pathKey);
      return;
    }
    const range = visibleRange(matched, event.result, contents);
    if (!range) return;

    const totalLines = contents.split("\n").length;
    const previous = this.progress.get(matched.pathKey);
    const progress: ReadProgress = previous?.contents === contents
      ? previous
      : { contents, totalLines, ranges: [] };
    progress.ranges = addRange(progress.ranges, range);
    this.progress.set(matched.pathKey, progress);
    if (!coversFile(progress)) return;

    this.progress.delete(matched.pathKey);
    this.completed.set(event.toolCallId, {
      parentToolCallId: matched.parentToolCallId,
      snapshot: {
        version: 1,
        source: "agent-read",
        toolCallId: event.toolCallId,
        skill: {
          name: truncateUtf8(matched.skill.name, MAX_SKILL_NAME_BYTES).value,
          path: truncateUtf8(matched.skill.path, MAX_SKILL_PATH_BYTES).value,
          contents,
        },
      },
    });
  }

  takeForTurn(toolResults: readonly ToolResultIdentity[]): AgentSkillReadSnapshot[] {
    const snapshots: AgentSkillReadSnapshot[] = [];
    for (const result of toolResults) {
      const completed = this.completed.get(result.toolCallId);
      if (result.toolName === "read" && completed && !completed.parentToolCallId) {
        snapshots.push(completed.snapshot);
        this.completed.delete(result.toolCallId);
      }
      // Nested results are not session messages. The parent's bounded record is
      // the persistence witness; complete=false still permits listed successful
      // calls, but omitted/error/unfinished calls must never acquire a row later.
      for (const call of result.nestedCalls?.calls ?? []) {
        if (call.name !== "read" || call.status !== "ok") continue;
        const nested = this.completed.get(call.id);
        if (nested?.parentToolCallId !== result.toolCallId) continue;
        snapshots.push(nested.snapshot);
        this.completed.delete(call.id);
      }
    }
    this.candidates.clear();
    this.completed.clear();
    return snapshots;
  }

  clear(): void {
    this.candidates.clear();
    this.progress.clear();
    this.completed.clear();
  }
}
