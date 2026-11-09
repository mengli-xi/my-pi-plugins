import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  sliceByColumn,
  visibleWidth,
  type EditorComponent,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  editorImageSegmentContract,
  hasAtomicImageSegmentContract,
} from "./compat/editor-image-segment.ts";
import {
  isPiClipboardImagePath,
  paintImageMarkers,
  replaceClipboardImagePaths,
} from "./image-marker.ts";
import { declareProbes, markBroken, markOk, type Probe } from "./internals.ts";
import { EDITOR_IMAGE_SOURCE_KEY } from "./integration-contracts.ts";
import type { Disposable } from "./lifecycle.ts";

const EDITOR_FACTORY_STATE = Symbol.for("pi-claude-style.editor-chrome.factory-state.v1");
const EDITOR_FACTORY_MARK = Symbol.for("pi-claude-style.editor-chrome.factory.v1");
const EDITOR_INSTANCE_STATE = Symbol.for("pi-claude-style.editor-chrome.instance-state.v1");
const EDITOR_INSTANCE_MARK = Symbol.for("pi-claude-style.editor-chrome.editor.v1");
const EDITOR_STATE_KEY = Symbol.for("pi-claude-style.editor-chrome.state.v1");
const IMAGE_PLACEHOLDER_STATE = Symbol.for("pi-claude-style.editor-chrome.image-placeholders.v1");
const RESET = "\x1b[0m";
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const GIT_POSITIVE = "\x1b[38;5;65m";
const GIT_NEGATIVE = "\x1b[38;5;95m";
const execFileAsync = promisify(execFile);

function constructProbeEditor(): Record<string, unknown> {
  const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
  };
  return new Editor(tui as never, theme as never, {} as never) as unknown as Record<string, unknown>;
}

export const PROBES: Probe[] = [
  {
    id: "editor-chrome.history",
    needs: "Editor instance history/historyIndex",
    breaks: "编辑器切换历史消息时不显示 History x/y",
    check: () => {
      const editor = constructProbeEditor();
      return Array.isArray(editor.history) && editor.historyIndex === -1;
    },
  },
  {
    id: "editor-chrome.atomicImageMarker",
    needs: "Editor instance segment(text, mode) atomic token contract",
    breaks: "clipboard 图片回退为原始路径，不显示可原子删除的 Image marker",
    check: () => hasAtomicImageSegmentContract(constructProbeEditor()),
  },
];

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type MarkedEditorFactory = EditorFactory & { [EDITOR_FACTORY_MARK]?: true; [EDITOR_FACTORY_STATE]?: EditorChromeState };
type ChromeEditor = EditorComponent & {
  history?: unknown;
  historyIndex?: unknown;
  setPaddingX?: (padding: number) => void;
  onSubmit?: (text: string) => void;
  [EDITOR_INSTANCE_MARK]?: true;
  [EDITOR_INSTANCE_STATE]?: EditorChromeState;
  [IMAGE_PLACEHOLDER_STATE]?: ImagePlaceholderState;
};

interface ImagePlaceholderState {
  nextId: number;
  images: Map<number, string>;
}

const IMAGE_MARKER_RE = /\[Image #(\d+)\]/g;

export interface GitBorderInfo {
  branch: string;
  additions: number;
  deletions: number;
  ahead: number;
  behind: number;
}

export interface HistoryPosition {
  current: number;
  total: number;
}

interface EditorImageSourceRegistry {
  version: 2;
  owner: object;
  sourceText(visibleText: string): string;
  restoredSource(sourceText: string): { handled: boolean; editorText: string };
}

interface EditorChromeState {
  owner?: object;
  name?: string;
  topRightLabel?: string;
  git?: GitBorderInfo;
  bottomLabel?: string;
  getTheme?: () => Theme;
  requestRender?: () => void;
  activeEditor?: ChromeEditor;
}

export interface EditorChromeInstallOptions {
  readGitStatus?: (cwd: string) => Promise<GitBorderInfo | undefined>;
  topRightLabel?: string;
  bottomLabel?: string;
  publishImageSource?: boolean;
}

function editorChromeState(): EditorChromeState {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const current = scope[EDITOR_STATE_KEY];
  if (typeof current === "object" && current !== null) return current as EditorChromeState;
  const created: EditorChromeState = {};
  scope[EDITOR_STATE_KEY] = created;
  return created;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function normalizedGitInfo(value: GitBorderInfo): GitBorderInfo {
  return {
    branch: value.branch,
    additions: nonNegativeInteger(value.additions),
    deletions: nonNegativeInteger(value.deletions),
    ahead: nonNegativeInteger(value.ahead),
    behind: nonNegativeInteger(value.behind),
  };
}

function truncateMiddle(value: string, width: number): string {
  if (width < 1) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  const headWidth = Math.ceil((width - 1) / 2);
  const tailWidth = Math.max(0, width - 1 - headWidth);
  return `${sliceByColumn(value, 0, headWidth, true)}…${sliceByColumn(
    value,
    Math.max(0, visibleWidth(value) - tailWidth),
    tailWidth,
    true,
  )}`;
}

interface EditorBorder {
  width: number;
}

function parseEditorBorder(line: string): EditorBorder | undefined {
  const plain = line.replace(ANSI_RE, "");
  if (/^─+$/.test(plain) || /^─+ .+ ─+$/.test(plain)) {
    return { width: visibleWidth(plain) };
  }
  return undefined;
}

function leadingColors(line: string): string {
  return line.match(/^(?:\x1b\[[0-9;]*m)*/)?.[0] ?? "";
}

function plainBorder(line: string, border: EditorBorder): string {
  const colors = leadingColors(line);
  return `${colors}${"─".repeat(border.width)}${colors ? RESET : ""}`;
}

function fitLabel(value: string, available: number): string {
  if (available < 3) return "";
  const content = truncateMiddle(value, available - 2);
  return content ? ` ${content} ` : "";
}

/** Paint history at the top-left and the session name at the top-right. */
export function paintTopBorder(
  line: string,
  name: string | undefined,
  history: HistoryPosition | undefined,
  theme: Theme,
): string {
  const border = parseEditorBorder(line);
  if (!border || border.width < 8) return line;
  const innerWidth = border.width - 4;
  const historyLabel = history ? ` History ${history.current}/${history.total} ` : "";
  if (visibleWidth(historyLabel) > innerWidth) return plainBorder(line, border);

  const remaining = innerWidth - visibleWidth(historyLabel);
  const nameLabel = name ? fitLabel(name, remaining) : "";
  const fill = Math.max(0, remaining - visibleWidth(nameLabel));
  if (!historyLabel && !nameLabel) return plainBorder(line, border);

  const colors = leadingColors(line);
  return [
    colors,
    "──",
    RESET,
    historyLabel ? theme.fg("muted", historyLabel) : "",
    colors,
    "─".repeat(fill),
    RESET,
    nameLabel ? theme.fg("muted", nameLabel) : "",
    colors,
    "──",
    RESET,
  ].join("");
}

interface GitLabelSegment {
  text: string;
  color: string;
}

function gitStatusSegments(info: GitBorderInfo): GitLabelSegment[] {
  return [
    ...(info.additions > 0 ? [{ text: `+${info.additions}`, color: GIT_POSITIVE }] : []),
    ...(info.deletions > 0 ? [{ text: `-${info.deletions}`, color: GIT_NEGATIVE }] : []),
    ...(info.ahead > 0 ? [{ text: `⇡${info.ahead}`, color: GIT_POSITIVE }] : []),
    ...(info.behind > 0 ? [{ text: `⇣${info.behind}`, color: GIT_NEGATIVE }] : []),
  ];
}

function segmentsWidth(segments: readonly GitLabelSegment[]): number {
  return segments.reduce((total, segment) => total + 1 + visibleWidth(segment.text), 0);
}

/** Paint right-aligned Git identity and state into the editor's bottom rule. */
export function paintGitBorder(line: string, value: GitBorderInfo, theme: Theme): string {
  const border = parseEditorBorder(line);
  const info = normalizedGitInfo(value);
  if (!border || border.width < 8 || !info.branch) return line;
  const available = border.width - 6;

  const status = gitStatusSegments(info);
  while (status.length > 0 && segmentsWidth(status) >= available) status.pop();
  const statusWidth = segmentsWidth(status);
  const branch = truncateMiddle(info.branch, Math.max(1, available - statusWidth));
  const labelWidth = visibleWidth(branch) + statusWidth;
  const colors = leadingColors(line);
  const head = "─".repeat(Math.max(2, border.width - labelWidth - 4));
  const paintedStatus = status
    .map((segment) => ` ${segment.color}${segment.text}${RESET}`)
    .join("");
  return `${colors}${head}${RESET}${theme.fg("dim", ` ${branch}`)}${paintedStatus}${theme.fg("dim", " ")}${colors}──${RESET}`;
}

export function paintBottomLabel(line: string, value: string, theme: Theme): string {
  const border = parseEditorBorder(line);
  const label = value.trim();
  if (!border || border.width < 8 || !label) return line;
  const rendered = truncateMiddle(label, Math.max(1, border.width - 6));
  const colors = leadingColors(line);
  const head = "─".repeat(Math.max(2, border.width - visibleWidth(rendered) - 4));
  return `${colors}${head}${RESET}${theme.fg("dim", ` ${rendered} `)}${colors}──${RESET}`;
}

/** Lay out every editor-border contribution in one pass. */
export function paintEditorChrome(
  lines: string[],
  values: {
    name?: string;
    history?: HistoryPosition;
    git?: GitBorderInfo;
    bottomLabel?: string;
  },
  theme: Theme,
): string[] {
  const borders = lines
    .map((line, index) => ({ index, border: parseEditorBorder(line) }))
    .filter((entry): entry is { index: number; border: EditorBorder } => entry.border !== undefined);
  if (borders.length < 2) return lines;

  const painted = [...lines];
  const top = borders[0]!;
  const bottom = borders[1]!;
  painted[top.index] = paintTopBorder(
    plainBorder(painted[top.index]!, top.border),
    values.name,
    values.history,
    theme,
  );
  painted[bottom.index] = values.bottomLabel
    ? paintBottomLabel(plainBorder(painted[bottom.index]!, bottom.border), values.bottomLabel, theme)
    : values.git
      ? paintGitBorder(plainBorder(painted[bottom.index]!, bottom.border), values.git, theme)
      : plainBorder(painted[bottom.index]!, bottom.border);
  return painted;
}

function historyPosition(editor: ChromeEditor): HistoryPosition | undefined {
  try {
    if (!("history" in editor) && !("historyIndex" in editor)) return undefined;
    if (!Array.isArray(editor.history) || !Number.isInteger(editor.historyIndex)) {
      markBroken("editor-chrome.history", "history/historyIndex shape is unavailable");
      return undefined;
    }
    markOk("editor-chrome.history");
    const index = editor.historyIndex as number;
    if (index < 0 || editor.history.length === 0) return undefined;
    if (index >= editor.history.length) {
      markBroken("editor-chrome.history", "historyIndex is outside the history array");
      return undefined;
    }
    return {
      // Pi stores input history newest-first: index 0 is the first entry
      // reached by ArrowUp, so the user-facing position counts down from total.
      current: editor.history.length - index,
      total: editor.history.length,
    };
  } catch (error) {
    markBroken("editor-chrome.history", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** The redraw handle comes from the public EditorFactory argument, never the editor's fields. */
function redrawFor(tui: Pick<TUI, "requestRender"> | undefined): (() => void) | undefined {
  return typeof tui?.requestRender === "function" ? () => tui.requestRender() : undefined;
}

function expandImageMarkers(text: string, images: ReadonlyMap<number, string>): string {
  return text.replace(IMAGE_MARKER_RE, (marker, id) => images.get(Number(id)) ?? marker);
}

function registerImagePaths(
  text: string,
  state: ImagePlaceholderState,
): string {
  const existingIds = [...text.matchAll(IMAGE_MARKER_RE)].map((match) => Number(match[1]));
  state.nextId = Math.max(state.nextId, ...existingIds);
  return replaceClipboardImagePaths(text, (marker, path) => {
    if (!existsSync(path)) return path;
    const id = ++state.nextId;
    state.images.set(id, path);
    return marker.replace(/#\d+/u, `#${id}`);
  });
}

function installImagePastePlaceholders(editor: ChromeEditor): void {
  if (editor[IMAGE_PLACEHOLDER_STATE]) return;
  const originalSetText = editor.setText.bind(editor);
  const originalInsertTextAtCursor = editor.insertTextAtCursor?.bind(editor);
  const originalGetExpandedText = editor.getExpandedText?.bind(editor);
  const segment = editorImageSegmentContract(editor);
  if (!originalInsertTextAtCursor || !segment) {
    markBroken("editor-chrome.atomicImageMarker", "Editor segment(text, mode) contract is unavailable");
    return;
  }
  markOk("editor-chrome.atomicImageMarker");
  const images = new Map<number, string>();
  const state: ImagePlaceholderState = { nextId: 0, images };
  segment.install(() => new Set(images.keys()));
  Object.defineProperty(editor, IMAGE_PLACEHOLDER_STATE, { value: state });

  editor.setText = (text: string): void => {
    images.clear();
    state.nextId = 0;
    originalSetText(registerImagePaths(text, state));
  };
  editor.insertTextAtCursor = (text: string): void => {
    if (!isPiClipboardImagePath(text)) {
      originalInsertTextAtCursor(text);
      return;
    }
    const id = ++state.nextId;
    images.set(id, text);
    originalInsertTextAtCursor(`[Image #${id}]`);
  };
  editor.getExpandedText = (): string => {
    const text = originalGetExpandedText ? originalGetExpandedText() : editor.getText();
    return expandImageMarkers(text, images);
  };

  let submit = editor.onSubmit;
  Object.defineProperty(editor, "onSubmit", {
    configurable: true,
    get() {
      return submit;
    },
    set(handler: ((text: string) => void) | undefined) {
      submit = handler
        ? (text: string) => {
          const expanded = expandImageMarkers(text, images);
          images.clear();
          state.nextId = 0;
          handler(expanded);
        }
        : undefined;
    },
  });
  if (submit) editor.onSubmit = submit;
}

/** Preserve the editor instance while giving CC Style sole ownership of its chrome. */
export function decorateEditorChrome(
  editor: ChromeEditor,
  state = editorChromeState(),
  tui?: Pick<TUI, "requestRender">,
): ChromeEditor {
  if (editor[EDITOR_INSTANCE_MARK]) {
    editor[EDITOR_INSTANCE_STATE] = state;
    state.activeEditor = editor;
    state.requestRender = redrawFor(tui);
    return editor;
  }
  if (typeof editor.setPaddingX !== "function") return editor;
  editor[EDITOR_INSTANCE_STATE] = state;

  installImagePastePlaceholders(editor);

  const originalRender = editor.render.bind(editor);
  const originalSetPaddingX = editor.setPaddingX.bind(editor);
  editor.setPaddingX = (padding: number): void => originalSetPaddingX(Math.max(2, padding));
  editor.setPaddingX(2);
  editor.render = (width: number): string[] => {
    const lines = originalRender(width);
    const current = editor[EDITOR_INSTANCE_STATE] ?? state;
    const theme = current.owner ? current.getTheme?.() : undefined;
    if (!theme) return lines;

    let painted = paintEditorChrome(lines, {
      name: current.topRightLabel ?? current.name,
      history: historyPosition(editor),
      git: current.git,
      bottomLabel: current.bottomLabel,
    }, theme);
    if (width >= 5 && painted.length >= 3 && painted[1]?.startsWith("  ")) {
      painted = [...painted];
      painted[1] = theme.fg("accent", "❯") + " " + painted[1]!.slice(2);
    }
    return paintImageMarkers(painted, theme);
  };
  Object.defineProperty(editor, EDITOR_INSTANCE_MARK, { value: true });
  state.activeEditor = editor;
  state.requestRender = redrawFor(tui);
  return editor;
}

export function wrapEditorChromeFactory(factory: EditorFactory | undefined, state = editorChromeState()): EditorFactory {
  if ((factory as MarkedEditorFactory | undefined)?.[EDITOR_FACTORY_MARK]) return factory!;
  const wrapped: MarkedEditorFactory = (tui, theme, keybindings) =>
    decorateEditorChrome(
      (factory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings)) as ChromeEditor, state, tui,
    );
  Object.defineProperty(wrapped, EDITOR_FACTORY_MARK, { value: true });
  Object.defineProperty(wrapped, EDITOR_FACTORY_STATE, { value: state });
  return wrapped;
}

export async function readGitBorderInfo(cwd: string): Promise<GitBorderInfo | undefined> {
  const runGit = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 1_000,
      maxBuffer: 1_048_576,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  };
  const [branchResult, diffResult, syncResult] = await Promise.allSettled([
    runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(["diff", "--numstat", "HEAD", "--"]),
    runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
  ]);
  if (branchResult.status !== "fulfilled" || !branchResult.value.trim()) return undefined;

  let additions = 0;
  let deletions = 0;
  if (diffResult.status === "fulfilled") {
    for (const line of diffResult.value.split("\n")) {
      const [added, removed] = line.split("\t", 2);
      if (/^\d+$/.test(added ?? "")) additions += Number(added);
      if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
    }
  }
  let ahead = 0;
  let behind = 0;
  if (syncResult.status === "fulfilled") {
    const [rawAhead, rawBehind] = syncResult.value.trim().split(/\s+/, 2);
    if (/^\d+$/.test(rawAhead ?? "")) ahead = Number(rawAhead);
    if (/^\d+$/.test(rawBehind ?? "")) behind = Number(rawBehind);
  }
  return {
    branch: branchResult.value.trim(),
    additions,
    deletions,
    ahead,
    behind,
  };
}

/** Install the single editor-chrome owner for every TUI session. */
export function installEditorChrome(
  pi: ExtensionAPI,
  options: EditorChromeInstallOptions = {},
): Disposable {
  declareProbes(PROBES);
  const owner = {};
  let state: EditorChromeState = {};
  const loadGitStatus = options.readGitStatus ?? readGitBorderInfo;
  let gitRequest = 0;

  const refreshGit = async (ctx: ExtensionContext): Promise<void> => {
    const request = ++gitRequest;
    let git: GitBorderInfo | undefined;
    try {
      git = await loadGitStatus(ctx.cwd);
    } catch {
      git = undefined;
    }
    if (request !== gitRequest || state.owner !== owner) return;
    state.git = git;
    state.requestRender?.();
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    let currentFactory: MarkedEditorFactory | undefined;
    try { currentFactory = ctx.ui.getEditorComponent() as MarkedEditorFactory | undefined; } catch { /* Retired UI. */ }
    state = currentFactory?.[EDITOR_FACTORY_STATE] ?? {};
    state.owner = owner;
    state.name = pi.getSessionName()?.trim() || undefined;
    state.topRightLabel = options.topRightLabel?.trim() || undefined;
    state.git = undefined;
    state.bottomLabel = options.bottomLabel?.trim() || undefined;
    state.getTheme = () => ctx.ui.theme;
    try {
      const current = ctx.ui.getEditorComponent();
      if (!(current as MarkedEditorFactory | undefined)?.[EDITOR_FACTORY_MARK]) {
        ctx.ui.setEditorComponent(wrapEditorChromeFactory(current, state));
      }
      const globals = globalThis as Record<PropertyKey, unknown>;
      if (options.publishImageSource !== false) globals[EDITOR_IMAGE_SOURCE_KEY] = {
        version: 2,
        owner,
        sourceText: (visibleText: string) => {
          try {
            const activeEditor = state.activeEditor;
            const images = activeEditor?.[IMAGE_PLACEHOLDER_STATE]?.images;
            return images ? expandImageMarkers(visibleText, images) : visibleText;
          } catch {
            return visibleText;
          }
        },
        restoredSource: (sourceText: string) => {
          try {
            const activeEditor = state.activeEditor;
            const images = activeEditor?.[IMAGE_PLACEHOLDER_STATE]?.images;
            const editorText = activeEditor?.getText();
            if (!images || images.size === 0 || typeof editorText !== "string") {
              return { handled: false, editorText: sourceText };
            }
            const hasUnresolvedPath = replaceClipboardImagePaths(editorText) !== editorText;
            const hasUnboundImage = editorText.split("\n").some((line) => line.trim() === "[Image]");
            return {
              handled: !hasUnresolvedPath
                && !hasUnboundImage
                && editorText !== sourceText
                && expandImageMarkers(editorText, images) === sourceText,
              editorText,
            };
          } catch {
            return { handled: false, editorText: sourceText };
          }
        },
      } satisfies EditorImageSourceRegistry;
    } catch {
      // A stale replacement-session context can lose its editor while wrapping.
    }
    void refreshGit(ctx);
  });
  pi.on("session_info_changed", (event) => {
    if (state.owner !== owner) return;
    state.name = event.name?.trim() || undefined;
    state.requestRender?.();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (state.owner === owner && ctx.mode === "tui" && ctx.hasUI) {
      void refreshGit(ctx);
    }
  });
  pi.on("session_shutdown", () => {
    gitRequest++;
    if (state.owner !== owner) return;
    state.name = undefined;
    state.topRightLabel = undefined;
    state.git = undefined;
    state.bottomLabel = undefined;
    state.getTheme = undefined;
    const globals = globalThis as Record<PropertyKey, unknown>;
    const registry = globals[EDITOR_IMAGE_SOURCE_KEY] as EditorImageSourceRegistry | undefined;
    if (registry?.owner === owner) delete globals[EDITOR_IMAGE_SOURCE_KEY];
    // Keep the bounded redraw closure with the versioned wrapper. Pi can reuse
    // the same editor instance across reload; the replacement owner adopts this
    // closure until a newly constructed editor replaces it.
  });

  return {
    dispose(): void {
      gitRequest++;
      if (state.owner !== owner) return;
      state.owner = undefined;
      state.name = undefined;
      state.topRightLabel = undefined;
      state.git = undefined;
      state.bottomLabel = undefined;
      state.getTheme = undefined;
      // Pi can reuse the exact editor instance across /reload. Keep its image
      // mapping available for the replacement runtime; a newly constructed
      // editor overwrites this reference in decorateEditorChrome().
      const globals = globalThis as Record<PropertyKey, unknown>;
      const registry = globals[EDITOR_IMAGE_SOURCE_KEY] as EditorImageSourceRegistry | undefined;
      if (registry?.owner === owner) delete globals[EDITOR_IMAGE_SOURCE_KEY];
    },
  };
}
