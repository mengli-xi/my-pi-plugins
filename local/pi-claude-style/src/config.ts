import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "./config/agent-dir.ts";
import type {
  AssistantMessagesConfig,
  DiffConfig,
  GroupingConfig,
  GoalConfig,
  CustomMessagesConfig,
  NativeToolOutputConfig,
  ImportantToolsConfig,
  OverlayConfig,
  SeparatorsConfig,
  TranscriptConfig,
  UserMessagesConfig,
  WorkingConfig,
} from "./types.ts";

const PACKAGE_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config.json",
);

export const CONFIG_PATH = join(
  getAgentDir(),
  "extensions",
  "pi-claude-transcript",
  "config.json",
);

export const DEFAULT_GROUPING: GroupingConfig = {
  read: true,
  search: true,
  list: true,
  bash: true,
  edit: true,
  write: true,
  mcp: true,
  subagent: true,
  process: true,
  memory: true,
  note: true,
  context: true,
  todo: true,
  unknown: true,
};

export const DEFAULT_IMPORTANT_TOOLS: ImportantToolsConfig = {
  askUserQuestion: true,
  webSearch: true,
  webFetch: true,
  singleFileEdit: true,
  todoList: true,
  webDetails: "overlay",
};

export const DEFAULT_WORKING: WorkingConfig = {
  enabled: true,
  style: "cyber",
  showDoneSummary: true,
  showInputTokens: true,
  showOutputTokens: true,
  showTps: true,
  showTtft: true,
  showThinkingTime: true,
  showTurns: true,
  showFinishedAt: true,
  showCancelHintAfterMs: 10_000,
  verbRotateMs: 8_000,
  spinnerIntervalMs: 180,
  refreshMs: 120,
  messageWidth: 100,
};

export const DEFAULT_DIFF: DiffConfig = {
  enabled: true,
  addedBg: 22,
  removedBg: 52,
  addedHighlightBg: 28,
  removedHighlightBg: 88,
};

export const DEFAULT_USER_MESSAGES: UserMessagesConfig = {
  enabled: true,
  style: "compact-box",
  title: "user",
  horizontalPadding: 1,
  verticalPadding: 0,
  topMargin: 0,
  maxLines: 3,
};

export const DEFAULT_ASSISTANT_MESSAGES: AssistantMessagesConfig = {
  enabled: true,
  style: "claude",
  marker: "●",
  markerColor: "accent",
  collapsedThinking: "activity",
  hideCodeFenceMarkers: true,
  typewriter: {
    enabled: true,
    adaptive: true,
    frameMs: 50,
    renderBudgetMs: 8,
    maxFrameMs: 200,
    minCharsPerFrame: 3,
    maxCharsPerFrame: 160,
    targetLagMs: 160,
    finalDrainMs: 1_200,
  },
};

export const DEFAULT_CUSTOM_MESSAGES: CustomMessagesConfig = {
  enabled: true,
  style: "claude",
  marker: "▸",
  stripEchoedHeading: true,
};

/**
 * `process` is `@aliou/pi-processes`, whose results carry a background
 * command's output. It is the tool that pays for this, and the only one listed
 * by default: capping a tool that already renders two rows gains nothing and
 * risks hiding the one row that mattered.
 */
export const DEFAULT_NATIVE_TOOL_OUTPUT: NativeToolOutputConfig = {
  enabled: true,
  maxLines: 2,
  tools: ["process"],
  respectExpanded: false,
  compactShell: true,
};

export const DEFAULT_GOAL: GoalConfig = {
  enabled: true,
  placement: "aboveEditor",
  label: "Goal",
  showText: false,
  showTokens: true,
  refreshMs: 1_000,
  completedLingerMs: 8_000,
};

export const DEFAULT_OVERLAY: OverlayConfig = {
  mouseScrollLines: 3,
};

export const DEFAULT_SEPARATORS: SeparatorsConfig = {
  enabled: true,
  showTurnSeparators: false,
  showTurnNumber: true,
  showRunSeparator: true,
  replaceDoneWidget: true,
};

export const DEFAULT_CONFIG: TranscriptConfig = {
  enabled: true,
  expandMode: "overlay",
  overlayShortcut: "alt+o",
  todoShortcut: "alt+t",
  todoCollapsed: false,
  maxGroups: 100,
  maxResultChars: 200_000,
  maxCapturedBytes: 16_000_000,
  grouping: DEFAULT_GROUPING,
  importantTools: DEFAULT_IMPORTANT_TOOLS,
  overlay: DEFAULT_OVERLAY,
  separators: DEFAULT_SEPARATORS,
  working: DEFAULT_WORKING,
  diff: DEFAULT_DIFF,
  userMessages: DEFAULT_USER_MESSAGES,
  assistantMessages: DEFAULT_ASSISTANT_MESSAGES,
  goal: DEFAULT_GOAL,
  customMessages: DEFAULT_CUSTOM_MESSAGES,
  nativeToolOutput: DEFAULT_NATIVE_TOOL_OUTPUT,
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function integerValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value as number))
    : fallback;
}

function normalizeGrouping(value: unknown): GroupingConfig {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_GROUPING).map(([key, fallback]) => [
      key,
      booleanValue(source[key], fallback),
    ]),
  ) as unknown as GroupingConfig;
}

function normalizeImportantTools(value: unknown): ImportantToolsConfig {
  const source = isRecord(value) ? value : {};
  return {
    askUserQuestion: booleanValue(
      source.askUserQuestion,
      DEFAULT_IMPORTANT_TOOLS.askUserQuestion,
    ),
    webSearch: booleanValue(
      source.webSearch,
      DEFAULT_IMPORTANT_TOOLS.webSearch,
    ),
    webFetch: booleanValue(
      source.webFetch,
      DEFAULT_IMPORTANT_TOOLS.webFetch,
    ),
    singleFileEdit: booleanValue(
      source.singleFileEdit,
      DEFAULT_IMPORTANT_TOOLS.singleFileEdit,
    ),
    todoList: booleanValue(
      source.todoList,
      DEFAULT_IMPORTANT_TOOLS.todoList,
    ),
    webDetails:
      source.webDetails === "overlay"
        ? source.webDetails
        : DEFAULT_IMPORTANT_TOOLS.webDetails,
  };
}

function normalizeWorking(value: unknown): WorkingConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(source.enabled, DEFAULT_WORKING.enabled),
    style:
      source.style === "plain" || source.style === "cyber"
        ? source.style
        : DEFAULT_WORKING.style,
    showDoneSummary: booleanValue(
      source.showDoneSummary,
      DEFAULT_WORKING.showDoneSummary,
    ),
    showInputTokens: booleanValue(
      source.showInputTokens,
      DEFAULT_WORKING.showInputTokens,
    ),
    showOutputTokens: booleanValue(
      source.showOutputTokens,
      DEFAULT_WORKING.showOutputTokens,
    ),
    showTps: booleanValue(source.showTps, DEFAULT_WORKING.showTps),
    showTtft: booleanValue(source.showTtft, DEFAULT_WORKING.showTtft),
    showThinkingTime: booleanValue(
      source.showThinkingTime,
      DEFAULT_WORKING.showThinkingTime,
    ),
    showTurns: booleanValue(source.showTurns, DEFAULT_WORKING.showTurns),
    showFinishedAt: booleanValue(
      source.showFinishedAt,
      DEFAULT_WORKING.showFinishedAt,
    ),
    showCancelHintAfterMs: integerValue(
      source.showCancelHintAfterMs,
      DEFAULT_WORKING.showCancelHintAfterMs,
      0,
      600_000,
    ),
    verbRotateMs: integerValue(
      source.verbRotateMs,
      DEFAULT_WORKING.verbRotateMs,
      1_000,
      120_000,
    ),
    spinnerIntervalMs: integerValue(
      source.spinnerIntervalMs,
      DEFAULT_WORKING.spinnerIntervalMs,
      80,
      2_000,
    ),
    refreshMs: integerValue(
      source.refreshMs,
      DEFAULT_WORKING.refreshMs,
      75,
      2_000,
    ),
    messageWidth: integerValue(
      source.messageWidth,
      DEFAULT_WORKING.messageWidth,
      40,
      300,
    ),
  };
}

function normalizeOverlay(value: unknown): OverlayConfig {
  const source = isRecord(value) ? value : {};
  return {
    mouseScrollLines: integerValue(
      source.mouseScrollLines,
      DEFAULT_OVERLAY.mouseScrollLines,
      1,
      20,
    ),
  };
}

function normalizeSeparators(value: unknown): SeparatorsConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(source.enabled, DEFAULT_SEPARATORS.enabled),
    showTurnSeparators: booleanValue(
      source.showTurnSeparators,
      DEFAULT_SEPARATORS.showTurnSeparators,
    ),
    showTurnNumber: booleanValue(
      source.showTurnNumber,
      DEFAULT_SEPARATORS.showTurnNumber,
    ),
    showRunSeparator: booleanValue(
      source.showRunSeparator,
      DEFAULT_SEPARATORS.showRunSeparator,
    ),
    replaceDoneWidget: booleanValue(
      source.replaceDoneWidget,
      DEFAULT_SEPARATORS.replaceDoneWidget,
    ),
  };
}

function normalizeDiff(value: unknown): DiffConfig {
  const source = isRecord(value) ? value : {};
  // 0-255 is the whole 256-colour space; anything else is a typo, not a colour.
  const color = (raw: unknown, fallback: number) => integerValue(raw, fallback, 0, 255);
  const legacyHighlight = color(source.highlightBg, DEFAULT_DIFF.addedHighlightBg);
  return {
    enabled: booleanValue(source.enabled, DEFAULT_DIFF.enabled),
    addedBg: color(source.addedBg, DEFAULT_DIFF.addedBg),
    removedBg: color(source.removedBg, DEFAULT_DIFF.removedBg),
    addedHighlightBg: color(source.addedHighlightBg, legacyHighlight),
    removedHighlightBg: color(source.removedHighlightBg, legacyHighlight),
  };
}

function normalizeUserMessages(value: unknown): UserMessagesConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(source.enabled, DEFAULT_USER_MESSAGES.enabled),
    style:
      source.style === "native" || source.style === "compact-box"
        ? source.style
        : DEFAULT_USER_MESSAGES.style,
    title: stringValue(source.title, DEFAULT_USER_MESSAGES.title).slice(0, 32),
    horizontalPadding: integerValue(
      source.horizontalPadding,
      DEFAULT_USER_MESSAGES.horizontalPadding,
      0,
      4,
    ),
    verticalPadding: integerValue(
      source.verticalPadding,
      DEFAULT_USER_MESSAGES.verticalPadding,
      0,
      3,
    ),
    topMargin: integerValue(
      source.topMargin,
      DEFAULT_USER_MESSAGES.topMargin,
      0,
      3,
    ),
    maxLines: integerValue(source.maxLines, DEFAULT_USER_MESSAGES.maxLines, 0, 200),
  };
}

function normalizeAssistantMessages(value: unknown): AssistantMessagesConfig {
  const source = isRecord(value) ? value : {};
  const marker = stringValue(
    source.marker,
    DEFAULT_ASSISTANT_MESSAGES.marker,
  ).slice(0, 8);
  return {
    enabled: booleanValue(source.enabled, DEFAULT_ASSISTANT_MESSAGES.enabled),
    style:
      source.style === "native" || source.style === "claude"
        ? source.style
        : DEFAULT_ASSISTANT_MESSAGES.style,
    marker,
    markerColor:
      source.markerColor === "accent" ||
      source.markerColor === "text" ||
      source.markerColor === "muted"
        ? source.markerColor
        : DEFAULT_ASSISTANT_MESSAGES.markerColor,
    collapsedThinking:
      source.collapsedThinking === "activity" ||
      source.collapsedThinking === "preview" ||
      source.collapsedThinking === "label"
        ? source.collapsedThinking
        : DEFAULT_ASSISTANT_MESSAGES.collapsedThinking,
    hideCodeFenceMarkers: booleanValue(
      source.hideCodeFenceMarkers,
      DEFAULT_ASSISTANT_MESSAGES.hideCodeFenceMarkers,
    ),
    typewriter: normalizeAssistantTypewriter(source.typewriter),
  };
}

function normalizeAssistantTypewriter(
  value: unknown,
): AssistantMessagesConfig["typewriter"] {
  const source = isRecord(value) ? value : {};
  const defaults = DEFAULT_ASSISTANT_MESSAGES.typewriter;
  const minCharsPerFrame = integerValue(
    source.minCharsPerFrame,
    defaults.minCharsPerFrame,
    1,
    1_000,
  );
  return {
    enabled: booleanValue(source.enabled, defaults.enabled),
    adaptive: booleanValue(source.adaptive, defaults.adaptive),
    frameMs: integerValue(source.frameMs, defaults.frameMs, 16, 1_000),
    renderBudgetMs: integerValue(
      source.renderBudgetMs,
      defaults.renderBudgetMs,
      1,
      100,
    ),
    maxFrameMs: integerValue(
      source.maxFrameMs,
      defaults.maxFrameMs,
      16,
      2_000,
    ),
    minCharsPerFrame,
    maxCharsPerFrame: Math.max(
      minCharsPerFrame,
      integerValue(
        source.maxCharsPerFrame,
        defaults.maxCharsPerFrame,
        1,
        10_000,
      ),
    ),
    targetLagMs: integerValue(
      source.targetLagMs,
      defaults.targetLagMs,
      16,
      10_000,
    ),
    finalDrainMs: integerValue(
      source.finalDrainMs,
      defaults.finalDrainMs,
      0,
      30_000,
    ),
  };
}

function normalizeCustomMessages(value: unknown): CustomMessagesConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(source.enabled, DEFAULT_CUSTOM_MESSAGES.enabled),
    style:
      source.style === "native" || source.style === "claude"
        ? source.style
        : DEFAULT_CUSTOM_MESSAGES.style,
    marker: stringValue(source.marker, DEFAULT_CUSTOM_MESSAGES.marker).slice(0, 4),
    stripEchoedHeading: booleanValue(
      source.stripEchoedHeading,
      DEFAULT_CUSTOM_MESSAGES.stripEchoedHeading,
    ),
  };
}

function normalizeNativeToolOutput(value: unknown): NativeToolOutputConfig {
  const source = isRecord(value) ? value : {};
  const tools = Array.isArray(source.tools)
    ? [
      ...new Set(
        source.tools
          .filter((tool): tool is string => typeof tool === "string")
          .map((tool) => tool.trim().toLowerCase())
          .filter((tool) => tool.length > 0),
      ),
    ].slice(0, 32)
    : DEFAULT_NATIVE_TOOL_OUTPUT.tools;
  return {
    enabled: booleanValue(source.enabled, DEFAULT_NATIVE_TOOL_OUTPUT.enabled),
    // One row leaves nothing but the hint, and a cap past a handful stops
    // being a fold; both ends are clamped rather than rejected.
    maxLines: integerValue(
      source.maxLines,
      DEFAULT_NATIVE_TOOL_OUTPUT.maxLines,
      2,
      20,
    ),
    tools,
    respectExpanded: booleanValue(
      source.respectExpanded,
      DEFAULT_NATIVE_TOOL_OUTPUT.respectExpanded,
    ),
    compactShell: booleanValue(
      source.compactShell,
      DEFAULT_NATIVE_TOOL_OUTPUT.compactShell,
    ),
  };
}

function normalizeGoal(value: unknown): GoalConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(source.enabled, DEFAULT_GOAL.enabled),
    placement:
      source.placement === "belowEditor" ||
        source.placement === "aboveEditor" ||
        source.placement === "statusline"
        ? source.placement
        : DEFAULT_GOAL.placement,
    label: stringValue(source.label, DEFAULT_GOAL.label).slice(0, 24),
    showText: booleanValue(source.showText, DEFAULT_GOAL.showText),
    showTokens: booleanValue(source.showTokens, DEFAULT_GOAL.showTokens),
    refreshMs: integerValue(source.refreshMs, DEFAULT_GOAL.refreshMs, 250, 10_000),
    completedLingerMs: integerValue(
      source.completedLingerMs,
      DEFAULT_GOAL.completedLingerMs,
      0,
      120_000,
    ),
  };
}

export function normalizeConfig(value: unknown): TranscriptConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(source.enabled, DEFAULT_CONFIG.enabled),
    expandMode:
      source.expandMode === "inline" || source.expandMode === "overlay"
        ? source.expandMode
        : DEFAULT_CONFIG.expandMode,
    overlayShortcut: stringValue(
      source.overlayShortcut,
      DEFAULT_CONFIG.overlayShortcut,
    ),
    todoShortcut: stringValue(source.todoShortcut, DEFAULT_CONFIG.todoShortcut),
    todoCollapsed: booleanValue(source.todoCollapsed, DEFAULT_CONFIG.todoCollapsed),
    maxGroups: integerValue(
      source.maxGroups,
      DEFAULT_CONFIG.maxGroups,
      10,
      1_000,
    ),
    maxResultChars: integerValue(
      source.maxResultChars,
      DEFAULT_CONFIG.maxResultChars,
      1_000,
      2_000_000,
    ),
    maxCapturedBytes: integerValue(
      source.maxCapturedBytes,
      DEFAULT_CONFIG.maxCapturedBytes,
      100_000,
      1_000_000_000,
    ),
    grouping: normalizeGrouping(source.grouping),
    importantTools: normalizeImportantTools(source.importantTools),
    overlay: normalizeOverlay(source.overlay),
    separators: normalizeSeparators(source.separators),
    working: normalizeWorking(source.working),
    diff: normalizeDiff(source.diff),
    userMessages: normalizeUserMessages(source.userMessages),
    assistantMessages: normalizeAssistantMessages(source.assistantMessages),
    goal: normalizeGoal(source.goal),
    customMessages: normalizeCustomMessages(source.customMessages),
    nativeToolOutput: normalizeNativeToolOutput(source.nativeToolOutput),
  };
}

export interface ConfigLoadResult {
  config: TranscriptConfig;
  error?: string;
}

export function loadConfig(path = CONFIG_PATH): ConfigLoadResult {
  try {
    return {
      config: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" && path === CONFIG_PATH) {
      return loadConfig(PACKAGE_CONFIG_PATH);
    }
    if (code === "ENOENT") return { config: DEFAULT_CONFIG };
    return {
      config: DEFAULT_CONFIG,
      error: `pi-claude-transcript config ignored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
