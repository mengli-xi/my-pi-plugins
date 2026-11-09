export type ExpandMode = "overlay" | "inline";
export type RunStatus = "running" | "done" | "failed" | "cancelled";
export type ToolStatus = "running" | "completed" | "failed" | "cancelled";
export type GroupStatus = "collecting" | "completed" | "failed" | "cancelled";
export type ToolPresentationKind =
  | "grouped"
  | "question"
  | "web-search"
  | "web-fetch"
  | "single-file-edit"
  | "native";

export interface ToolPresentation {
  kind: ToolPresentationKind;
}

export interface GroupingConfig {
  read: boolean;
  search: boolean;
  list: boolean;
  bash: boolean;
  edit: boolean;
  write: boolean;
  mcp: boolean;
  subagent: boolean;
  process: boolean;
  memory: boolean;
  note: boolean;
  context: boolean;
  todo: boolean;
  unknown: boolean;
}

export interface WorkingConfig {
  enabled: boolean;
  style: "cyber" | "plain";
  showDoneSummary: boolean;
  showInputTokens: boolean;
  showOutputTokens: boolean;
  showTps: boolean;
  showTtft: boolean;
  showThinkingTime: boolean;
  showTurns: boolean;
  /** Append the wall-clock time the run ended to the done row. */
  showFinishedAt: boolean;
  showCancelHintAfterMs: number;
  verbRotateMs: number;
  spinnerIntervalMs: number;
  refreshMs: number;
  messageWidth: number;
}

export interface ImportantToolsConfig {
  askUserQuestion: boolean;
  webSearch: boolean;
  webFetch: boolean;
  singleFileEdit: boolean;
  /**
   * Keeps todo-list tools out of grouping so a provider's own `renderCall` /
   * `renderResult` (Magic Context ships one) still draws the checklist.
   */
  todoList: boolean;
  webDetails: "overlay";
}

export interface DiffConfig {
  enabled: boolean;
  /**
   * 256-colour indices for the rows and for the changed words inside them.
   * Foregrounds are not here: pi applies `toolDiffAdded` / `toolDiffRemoved`
   * from the active theme before these lines ever reach us.
   */
  addedBg: number;
  removedBg: number;
  addedHighlightBg: number;
  removedHighlightBg: number;
}

export interface UserMessagesConfig {
  enabled: boolean;
  style: "compact-box" | "native";
  title: string;
  horizontalPadding: number;
  verticalPadding: number;
  topMargin: number;
  /**
   * Body lines to show before folding the rest away; 0 keeps the whole message.
   * A folded message says how much it is holding back, and clicking it opens
   * the full text in the popup.
   */
  maxLines: number;
}

export interface AssistantMessagesConfig {
  enabled: boolean;
  style: "claude" | "native";
  marker: string;
  markerColor: "accent" | "text" | "muted";
  /**
   * `activity` keeps one clickable elapsed-time row per thinking run, freezes
   * its timer when the run ends, and streams that run into an open panel;
   * `preview` and `label` preserve the legacy folded presentations as explicit
   * opt-ins.
   */
  collapsedThinking: "activity" | "preview" | "label";
  /** Hide the rendered opening and closing Markdown code-fence marker rows. */
  hideCodeFenceMarkers: boolean;
  /** Smooth bursty provider text deltas before handing them to Markdown. */
  typewriter: AssistantTypewriterConfig;
}

export interface AssistantTypewriterConfig {
  enabled: boolean;
  /** Slow future frames when Markdown/paint/event-loop work exceeds budget. */
  adaptive: boolean;
  /** Minimum delay between Markdown rebuilds while text is streaming. */
  frameMs: number;
  /** Target maximum main-thread cost attributed to one visible update. */
  renderBudgetMs: number;
  /** Upper bound for adaptive spacing between Markdown rebuilds. */
  maxFrameMs: number;
  /** Smallest visible progress made by an active frame. */
  minCharsPerFrame: number;
  /** Upper bound for one frame, limiting both jumps and render work. */
  maxCharsPerFrame: number;
  /** Adaptive drain target while the provider is still producing deltas. */
  targetLagMs: number;
  /** Maximum time spent draining the tail after message_end. */
  finalDrainMs: number;
}

export interface OverlayConfig {
  /** Transcript lines a wheel notch scrolls inside a popup. */
  mouseScrollLines: number;
}

export interface SeparatorsConfig {
  enabled: boolean;
  showTurnSeparators: boolean;
  showTurnNumber: boolean;
  showRunSeparator: boolean;
  replaceDoneWidget: boolean;
}

export interface CustomMessagesConfig {
  enabled: boolean;
  /** `claude` renders a compact row; `native` keeps Pi's boxed output. */
  style: "claude" | "native";
  marker: string;
  /** Drop a leading heading that only repeats the command name. */
  stripEchoedHeading: boolean;
}

/**
 * Capping the result rows of tools that keep their own renderer — the ones Pi
 * loads directly, so this extension never gets to group them.
 */
export interface NativeToolOutputConfig {
  enabled: boolean;
  /** Rows a listed tool's result may occupy, hint row included. */
  maxLines: number;
  /** Tool names to cap, matched case-insensitively. */
  tools: string[];
  /**
   * Let `Ctrl+O` lift the cap and show the tool's output in place. Off by
   * default: a grouped row does not grow when tools are expanded either, and a
   * transcript kept short only while nothing is expanded is not kept short.
   */
  respectExpanded: boolean;
  /**
   * Draw these tools in the shell this extension's own rows use instead of
   * Pi's default one, which spends three blank rows and a padded, tinted box
   * on every call.
   */
  compactShell: boolean;
}

export interface GoalConfig {
  enabled: boolean;
  /**
   * Where the goal row is drawn. `statusline` hands it to `pi-statusline` as a
   * row of its own under the command's, right-aligned; the two editor
   * placements draw a widget here instead. Falls back to a widget, then to
   * `setStatus`, when the chosen home does not answer.
   */
  placement: "aboveEditor" | "belowEditor" | "statusline";
  label: string;
  showText: boolean;
  /** Show tokens billed since the goal started. */
  showTokens: boolean;
  refreshMs: number;
  /** How long a finished goal keeps showing "Done" after pi-goal clears it. */
  completedLingerMs: number;
}

export interface TranscriptConfig {
  enabled: boolean;
  expandMode: ExpandMode;
  overlayShortcut: string;
  /** Toggles the todo list between one row per task and a single summary row. */
  todoShortcut: string;
  /** Whether the todo list starts folded. A session toggle overrides it. */
  todoCollapsed: boolean;
  /** Full-payload tool groups and completed Activity phases retained per session. */
  maxGroups: number;
  maxResultChars: number;
  /** Total UTF-8 bytes retained independently by tool payloads and Thinking payloads. */
  maxCapturedBytes: number;
  grouping: GroupingConfig;
  importantTools: ImportantToolsConfig;
  overlay: OverlayConfig;
  separators: SeparatorsConfig;
  working: WorkingConfig;
  diff: DiffConfig;
  userMessages: UserMessagesConfig;
  assistantMessages: AssistantMessagesConfig;
  goal: GoalConfig;
  customMessages: CustomMessagesConfig;
  nativeToolOutput: NativeToolOutputConfig;
}

export interface CapturedImageSummary {
  count: number;
  totalBytes: number;
}

export interface CapturedResult {
  text: string;
  truncated: boolean;
  isError: boolean;
  details?: unknown;
  /** How many images the result carried; the payload itself stays in Pi's result. */
  imageSummary?: CapturedImageSummary;
}

export interface ToolActivity {
  /** Root model-issued call; nested tools share its group and transcript row. */
  parentToolCallId?: string;
  id: string;
  groupId: string;
  toolName: string;
  args: unknown;
  result?: CapturedResult;
  status: ToolStatus;
  startedAt: number;
  endedAt?: number;
  /** Pi's monotonic execution duration; independent of assistant generation time. */
  durationMs?: number;
}

export interface ToolGroup {
  id: string;
  anchorToolCallId: string;
  presentation: Exclude<ToolPresentationKind, "native">;
  activities: ToolActivity[];
  status: GroupStatus;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every mutation so renderers can cache against it. */
  version: number;
  /** Captured payloads were released to cap memory; the row still renders. */
  pruned?: boolean;
}

export type ToolGroupTone = "success" | "error" | "customMessageLabel";

export interface ToolGroupSnapshot {
  id: string;
  anchorToolCallId: string;
  presentation: Exclude<ToolPresentationKind, "native">;
  activities: readonly ToolActivity[];
  status: GroupStatus;
  createdAt: number;
  updatedAt: number;
  failureCount: number;
  runningCount: number;
  /** Captured payloads were released; summaries still render, details are gone. */
  pruned?: boolean;
}

export interface RunMetricsSnapshot {
  status: RunStatus;
  phase: "idle" | "thinking" | "generating" | "tool";
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  outputEstimated: boolean;
  tps?: number;
  tpsEstimated: boolean;
  ttftMs?: number;
  thinkingMs?: number;
  turnCount: number;
  /**
   * When the run ended, as an epoch millisecond value. Absent while it is
   * still going — the done row is the only thing that reads it, and a running
   * row has no end to report.
   */
  endedAt?: number;
}

export interface ToolRendererRegistration {
  toolCallId: string;
  invalidate: () => void;
}
