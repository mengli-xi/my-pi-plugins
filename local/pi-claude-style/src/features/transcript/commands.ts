import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { executeCcStyleCommand, presentCcStyleResult } from "../../commands/cc-style.ts";
import { CONFIG_PATH } from "../../config.ts";
import type { ActivityTimelineStore } from "../../activity-timeline.ts";
import type { ConfigService } from "../../config/service.ts";
import type { GroupStore } from "../../grouping.ts";
import type { LifecycleManager } from "../../lifecycle.ts";
import type { CcStyleObservability } from "../../observability.ts";
import { toggleTodoView, type TodoSnapshot } from "../../todo-state.ts";
import type { ToolActivity, TranscriptConfig } from "../../types.ts";
import { groupLabel, type TranscriptOverlayActions } from "./overlay-actions.ts";

export interface TranscriptCommandOptions {
  pi: ExtensionAPI;
  config: TranscriptConfig;
  configService?: ConfigService;
  observability: CcStyleObservability;
  lifecycle: LifecycleManager;
  store: GroupStore;
  activityTimeline: ActivityTimelineStore;
  todos: TodoSnapshot;
  drawTodos(ctx: ExtensionContext): void;
  overlayActions: TranscriptOverlayActions;
  formatActivity(activity: ToolActivity): string;
}

const TOOL_TRANSCRIPT_COMMANDS = ["show", "config"] as const;

export function toolTranscriptArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const query = prefix.trim().toLowerCase();
  const matches = TOOL_TRANSCRIPT_COMMANDS
    .filter((value) => query !== value && value.startsWith(query))
    .map((value) => ({ value, label: value }));
  return matches.length > 0 ? matches : null;
}

/** Register transcript-owned shortcuts and the legacy compatibility command. */
export function registerTranscriptCommands(options: TranscriptCommandOptions): void {
  const {
    pi,
    config,
    configService,
    observability,
    lifecycle,
    store,
    activityTimeline,
    todos,
    drawTodos,
    overlayActions,
    formatActivity,
  } = options;
  const activitySource = (group: ReturnType<GroupStore["latestInspectable"]>) => {
    if (!group || group.presentation !== "grouped") return undefined;
    const phase = activityTimeline.phaseForToolCall(group.anchorToolCallId);
    return phase
      ? {
        phase,
        resolveActivity: (id: string) => store.getActivity(id),
        resolveNestedActivities: (id: string) => store.getByToolCallId(id)?.activities.filter((child) => child.parentToolCallId === id) ?? [],
        subscribe: (listener: Parameters<ActivityTimelineStore["subscribe"]>[1]) =>
          activityTimeline.subscribe(phase.id, listener),
      }
      : undefined;
  };
  const presentLegacy = (ctx: ExtensionContext, text: string) => presentCcStyleResult(pi, ctx as any, {
    title: "Tool transcript (deprecated)",
    text: `Deprecated: use /cc-style\n${text}`,
    long: text.includes("\n"),
  });

  pi.registerShortcut(config.todoShortcut as KeyId, {
    description: "Fold the todo list to a single row, or unfold it",
    handler: (ctx) => {
      if (!ctx.hasUI) return;
      if (todos.visible().length === 0) {
        ctx.ui.notify("No todo list to fold", "info");
        return;
      }
      toggleTodoView(todos, () => drawTodos(ctx));
    },
  });

  pi.registerShortcut(config.overlayShortcut as KeyId, {
    description: "Open the latest inspectable tool transcript item",
    handler: async (ctx) => {
      const group = store.latestInspectable();
      if (!group) {
        if (ctx.hasUI) ctx.ui.notify("No grouped tool transcript yet", "info");
        return;
      }
      await overlayActions.openGroup(
        ctx,
        group,
        config.maxResultChars,
        config.overlay,
        config.diff,
        formatActivity,
        (listener) => store.subscribe(group.id, listener),
        activitySource(group),
      );
    },
  });

  pi.registerCommand("tool-transcript", {
    description: "Browse grouped tools or show pi-claude-transcript status",
    getArgumentCompletions: toolTranscriptArgumentCompletions,
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "show" && configService) {
        const result = await executeCcStyleCommand("status", configService, observability, { lifecycle });
        await presentLegacy(ctx, `Use /cc-style status\n${result.text}`);
        return;
      }
      if (command === "show") {
        await presentLegacy(ctx, [
            `mode: ${config.expandMode}`,
            `groups: ${store.list().length}`,
            `important tools: question=${config.importantTools.askUserQuestion ? "on" : "off"}, web-search=${config.importantTools.webSearch ? "on" : "off"}, web-fetch=${config.importantTools.webFetch ? "on" : "off"}, edit=${config.importantTools.singleFileEdit ? "on" : "off"}`,
            `separators: ${config.separators.enabled ? "on" : "off"}`,
            "extensions: Pi settings-owned (direct load)",
            `user messages: ${config.userMessages.enabled ? config.userMessages.style : "native"}`,
            `assistant messages: ${config.assistantMessages.enabled ? config.assistantMessages.style : "native"}`,
          ].join("\n"));
        return;
      }
      if (command === "config" && configService) {
        const result = await executeCcStyleCommand("config path", configService, observability);
        await presentLegacy(ctx, `Use /cc-style config path\n${result.text}`);
        return;
      }
      if (command === "config") {
        await presentLegacy(ctx, `Config service disabled; edit legacy ${CONFIG_PATH} and run /reload`);
        return;
      }
      const groups = store.listInspectable();
      if (!groups.length) {
        await presentLegacy(ctx, "No grouped tool transcript yet");
        return;
      }
      if (ctx.mode !== "tui") {
        await presentLegacy(ctx, ["Grouped tool transcript:", ...groups.map((group, index) => groupLabel(group, index, ctx.cwd))].join("\n"));
        return;
      }
      if (groups.length === 1) {
        await overlayActions.openGroup(
          ctx,
          groups[0]!,
          config.maxResultChars,
          config.overlay,
          config.diff,
          formatActivity,
          (listener) => store.subscribe(groups[0]!.id, listener),
          activitySource(groups[0]),
        );
        return;
      }
      const labels = groups.map((group, index) => groupLabel(group, index, ctx.cwd));
      const selected = await ctx.ui.select("Tool transcript", labels);
      if (!selected) return;
      const index = labels.indexOf(selected);
      if (index >= 0) {
        await overlayActions.openGroup(
          ctx,
          groups[index]!,
          config.maxResultChars,
          config.overlay,
          config.diff,
          formatActivity,
          (listener) => store.subscribe(groups[index]!.id, listener),
          activitySource(groups[index]),
        );
      }
    },
  });
}
