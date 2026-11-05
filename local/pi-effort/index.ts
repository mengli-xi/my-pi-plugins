/**
 * pi-effort — `/effort`, a Claude Code-style picker for how hard the model
 * thinks before it answers.
 *
 * Pi 1.5 already exposes thinking levels through `/thinking`, keybindings and
 * settings. This adds `/effort`, a shared slider, a clickable statusline slot
 * and the optional ultra fragment: `/effort high` sets a real level outright.
 *
 * The ladder carries one rung pi does not have. `ultra` pins the model's top
 * real level and additionally contributes a proactive-delegation fragment to
 * the system prompt (see ultra.ts) — so picking `max` and picking `ultra`
 * are different acts, and only the latter injects. The flag is per session and
 * survives reload/resume/fork; any other level clears it.
 *
 * See levels.ts for the ladder and argument parsing, selector.ts for the panel.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  EFFORT_DESCRIPTIONS,
  type EffortLevel,
  matchLevel,
  type ModelLike,
  type PiLevel,
  supportedLevels,
  topPiLevel,
} from "./levels.js";
import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { EffortSelector } from "./selector.js";
import {
  loadUltraPrompt,
  missingToolWarning,
  readUltraConfig,
  restoreUltra,
  subagentPackageEnabled,
  ULTRA_FRAGMENT_KEY,
  ULTRA_STATE_ENTRY_TYPE,
  ultraGate,
  type UltraConfig,
} from "./ultra.js";

/** Owned by pi-claude-style; copied to avoid a runtime package import. */
const STATUS_LINE_ROW_CHANNEL = "statusline:row";
const STATUS_LINE_EFFORT_SLOT_KEY = "effort";
/** Owned by pi-model-prompts (contracts.ts); copied per the same convention. */
const PROMPT_FRAGMENTS_CHANNEL = "prompt:fragments-v1";
const ANSI_BLUE = "\x1b[34m";
const ANSI_MAGENTA = "\x1b[35m";
const ANSI_RESET = "\x1b[0m";

interface UltraStateEntry {
  enabled: boolean;
}

export default function piEffort(pi: ExtensionAPI): void {
  /**
   * Argument completion runs without a context, so the levels the current
   * model offers are remembered from the last time we did have one. Before
   * model discovery, do not invent model-specific completion candidates.
   */
  let knownLevels: EffortLevel[] = [];

  const agentDir = getAgentDir();
  /** Ultra is per session; `false` until a branch entry says otherwise. */
  let ultraOn = false;
  /** The real level ultra pinned, so a change made elsewhere can clear it. */
  let ultraPinned: PiLevel | undefined;
  /** One missing-tool warning per session is information; every run is noise. */
  let warnedMissingTool = false;
  let warnedUltraError: unknown;
  const remember = (source: { model: ModelLike | undefined }): EffortLevel[] => {
    const levels = supportedLevels(source.model);
    knownLevels = source.model ? levels : [];
    return levels;
  };

  const warnUltraError = (error: unknown, ctx?: ExtensionContext): void => {
    if (error === warnedUltraError) return;
    warnedUltraError = error;
    const message = `ultra: delegation prompt disabled — ${error instanceof Error ? error.message : "Unknown configuration error"}`;
    if (ctx?.hasUI) ctx.ui.notify(message, "warning");
    else console.error(message);
  };

  const setUltra = (enabled: boolean, pinned?: PiLevel): void => {
    if (ultraOn === enabled && (!enabled || ultraPinned === pinned)) return;
    ultraOn = enabled;
    ultraPinned = enabled ? pinned : undefined;
    if (!enabled) warnedMissingTool = false;
    pi.appendEntry<UltraStateEntry>(ULTRA_STATE_ENTRY_TYPE, { enabled });
  };

  /** Apply a level and report what actually took effect. */
  const apply = (level: EffortLevel, ctx: ExtensionContext): void => {
    if (level === "ultra") {
      const top = topPiLevel(remember(ctx));
      if (!top) {
        ctx.ui.notify("This model has no reasoning level for ultra to sit on.", "warning");
        return;
      }
      pi.setThinkingLevel(top);
      const after = pi.getThinkingLevel() as PiLevel;
      setUltra(true, after);
      publishStatusline(ctx);

      // One notification carries everything about the switch: what took
      // effect, whether the delegation prompt can actually apply, and why the
      // flourish sat this one out when it did.
      let config: UltraConfig;
      try {
        config = readUltraConfig(agentDir);
      } catch (error) {
        warnUltraError(error, ctx);
        return;
      }
      if (subagentPackageEnabled(agentDir, config) === false) {
        ctx.ui.notify(
          `ultra is on (${after} + delegation prompt), but ${config.subagentPackage} is not enabled in settings — the prompt stays off until its \`${config.subagentTool}\` tool is present.`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(`Reasoning effort: ultra — ${after}; proactive delegation requires the prompt owner and confirmed tool`, "info");
      return;
    }

    const before = pi.getThinkingLevel();
    if (level === before && !ultraOn) {
      ctx.ui.notify(`Reasoning effort is already ${level} — ${EFFORT_DESCRIPTIONS[level]}`, "info");
      return;
    }

    // Any explicit non-ultra choice leaves ultra, even when the underlying
    // level is unchanged: `max` and `ultra` are different requests.
    setUltra(false);
    pi.setThinkingLevel(level);

    // pi clamps to what the model supports. Say so rather than letting the
    // notification claim a level that was quietly downgraded.
    const after = pi.getThinkingLevel();
    publishStatusline(ctx);
    if (after !== level) {
      ctx.ui.notify(`${level} is not available on this model — using ${after} instead`, "warning");
      return;
    }
    ctx.ui.notify(`Reasoning effort: ${level} — ${EFFORT_DESCRIPTIONS[level]}`, "info");
  };

  const pick = async (
    levels: EffortLevel[],
    current: EffortLevel,
    ctx: ExtensionContext,
  ): Promise<EffortLevel | undefined> => {
    if (ctx.mode === "tui") {
      const overlay = createEditorOverlayMount();
      const chosen = await ctx.ui.custom<EffortLevel | null>((tui, theme, _keybindings, done) => {
        return overlay.mount(tui, new EffortSelector(tui, theme, {
          levels,
          current,
          onSelect: (level) => done(level),
          onCancel: () => done(null),
        }));
      }, overlay.customOptions);
      return chosen ?? undefined;
    }

    // RPC and other UI-capable hosts get pi's plain selector; the labels carry
    // the same information the panel does, minus the layout.
    const labels = levels.map(
      (level) =>
        `${level}${level === current ? " (current)" : ""} — ${EFFORT_DESCRIPTIONS[level]}`,
    );
    const chosen = await ctx.ui.select("Reasoning effort", labels);
    const index = chosen === undefined ? -1 : labels.indexOf(chosen);
    return index === -1 ? undefined : levels[index];
  };

  let activeCtx: ExtensionContext | undefined;
  let pickerOpen = false;
  let pickerGeneration = 0;

  /** What the picker and statusline call the current rung. */
  const currentRung = (): EffortLevel => (ultraOn ? "ultra" : pi.getThinkingLevel());

  const withdrawStatusline = (): void => {
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, { key: STATUS_LINE_EFFORT_SLOT_KEY });
  };

  const publishStatusline = (
    ctx: ExtensionContext,
    source: { model: ModelLike | undefined } = ctx,
  ): void => {
    activeCtx = ctx;
    const levels = remember(source);
    if (!ctx.hasUI || levels.length < 2) {
      withdrawStatusline();
      return;
    }
    const current = currentRung();
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, {
      key: STATUS_LINE_EFFORT_SLOT_KEY,
      placement: "slot",
      // Preserve the shell statusline's established blue presentation; ultra
      // is the one rung that is this package's own, so it reads differently.
      line: `${ultraOn ? ANSI_MAGENTA : ANSI_BLUE}${current}${ANSI_RESET}`,
      onClick: () => {
        if (pickerOpen || activeCtx !== ctx) return false;
        pickerOpen = true;
        const pickerRequest = ++pickerGeneration;
        void pick(remember(ctx), currentRung(), ctx)
          .then((chosen) => {
            if (chosen !== undefined && activeCtx === ctx && pickerGeneration === pickerRequest) {
              apply(chosen, ctx);
            }
          })
          .catch((error: unknown) => {
            if (activeCtx === ctx && pickerGeneration === pickerRequest) {
              ctx.ui.notify(
                `Unable to open reasoning effort picker: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
            }
          })
          .finally(() => {
            if (pickerGeneration === pickerRequest) pickerOpen = false;
          });
        return true;
      },
    });
  };

  pi.on("session_start", (_event, ctx) => {
    ultraOn = restoreUltra(ctx.sessionManager.getBranch());
    ultraPinned = ultraOn ? (pi.getThinkingLevel() as PiLevel) : undefined;
    warnedMissingTool = false;
    warnedUltraError = undefined;
    publishStatusline(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    publishStatusline(ctx, { model: event.model });
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    // A level changed outside this command — pi's own selector or keybinding —
    // is a plain level choice, so it leaves ultra. Our own apply() has already
    // pinned the level it set, which is how this tells the two apart.
    if (ultraOn && pi.getThinkingLevel() !== ultraPinned) setUltra(false);
    publishStatusline(ctx);
  });
  pi.on("session_shutdown", () => {
    activeCtx = undefined;
    knownLevels = [];
    ultraOn = false;
    ultraPinned = undefined;
    pickerGeneration++;
    pickerOpen = false;
    withdrawStatusline();
  });

  /**
   * Contribute the delegation fragment while ultra is on. The owner
   * (pi-model-prompts) emits this synchronously once per run; a session
   * without the sub-agent tool contributes nothing and says so once.
   */
  pi.events.on(PROMPT_FRAGMENTS_CHANNEL, (data: unknown) => {
    if (!ultraOn || typeof data !== "object" || data === null) return;
    const request = data as {
      selectedTools?: readonly string[];
      contribute?: (key: string, text: string) => void;
    };
    if (typeof request.contribute !== "function") return;
    let config: UltraConfig;
    let gate: ReturnType<typeof ultraGate>;
    try {
      config = readUltraConfig(agentDir);
      gate = ultraGate({
        enabled: true,
        selectedTools: request.selectedTools,
        config,
        text: loadUltraPrompt(agentDir),
      });
      warnedUltraError = undefined;
    } catch (error) {
      warnUltraError(error, activeCtx);
      return;
    }
    if (gate.inject) {
      request.contribute(ULTRA_FRAGMENT_KEY, gate.text);
      return;
    }
    if (gate.reason === "missing-tool" && !warnedMissingTool) {
      warnedMissingTool = true;
      const message = missingToolWarning(config);
      if (activeCtx?.hasUI) activeCtx.ui.notify(message, "warning");
      else console.error(message);
    }
  });

  pi.registerCommand("effort", {
    description: "Set reasoning effort — how hard the model thinks before answering",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = knownLevels
        .filter((level) => level.startsWith(prefix.trim().toLowerCase()))
        .map((level) => ({ value: level, label: level, description: EFFORT_DESCRIPTIONS[level] }));
      return items.length > 0 ? items : null;
    },

    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const levels = remember(ctx);
      const current = currentRung();
      const query = args.trim();

      if (query !== "") {
        const match = matchLevel(query, levels);
        if (match.ok) apply(match.level, ctx);
        else ctx.ui.notify(match.message, "warning");
        return;
      }

      if (levels.length < 2) {
        const model = ctx.model?.name ?? ctx.model?.id ?? "This model";
        ctx.ui.notify(`${model} has no reasoning effort to set.`, "warning");
        return;
      }

      if (!ctx.hasUI) {
        // Print and JSON modes have nowhere to show a picker; the argument
        // form (`pi -p "/effort high"`) is the one that works there.
        ctx.ui.notify(`Reasoning effort: ${current}. Pass a level, e.g. /effort high`, "info");
        return;
      }

      const chosen = await pick(levels, current, ctx);
      if (chosen !== undefined) apply(chosen, ctx);
    },
  });
}
