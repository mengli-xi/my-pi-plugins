/**
 * pi-model-prompts — the one place system-prompt additions are assembled.
 *
 * Two sources feed it, and both land in the same place at the same time:
 *
 *   1. `getAgentDir()/model-prompts/<model-id>.md` — per-model calibration,
 *      checked each run; changed versions are read on the next message
 *      without reloading Pi. Model ids containing path separators map to file
 *      names with `/` replaced by `_`, keeping the lookup inside the dir.
 *   2. Fragments other packages contribute over `prompt:fragments-v1` (see
 *      contracts.ts) — e.g. pi-effort's ultra mode. Pull-based and
 *      synchronous, so load order does not matter and there is no cache.
 *
 * Everything collected is appended in key order, once, at the end of the
 * assembled system prompt. Having a single owner is the point: three packages
 * each appending their own tail is how prompts start contradicting each other.
 *
 * `/model-prompt` reports what the current model resolves to and what the last
 * run actually injected, fragment by fragment.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { showTextPanel } from "pi-li-uikit/text-panel";
import { join } from "node:path";

import { promptsForModel } from "./bindings.ts";
import { PROMPT_FRAGMENTS_CHANNEL, type PromptFragmentsRequest } from "./contracts.ts";
import { assembleFragments, buildReport, type LastRun, loadModelPrompt } from "./report.ts";
import { openSettings } from "./settings.ts";

const SETTINGS_SUBCOMMAND = "settings";

export function modelPromptArgumentCompletions(prefix: string): Array<{ value: string; label: string; description: string }> | null {
  const query = prefix.trim().toLowerCase();
  if (query === SETTINGS_SUBCOMMAND || !SETTINGS_SUBCOMMAND.startsWith(query)) return null;
  return [{ value: SETTINGS_SUBCOMMAND, label: SETTINGS_SUBCOMMAND, description: "Bind prompts to models" }];
}

export default function piModelPrompts(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const dir = join(agentDir, "model-prompts");
  let lastRun: LastRun | undefined;
  pi.on("session_start", () => { lastRun = undefined; });
  pi.on("session_shutdown", () => { lastRun = undefined; });

  pi.on("before_agent_start", (event, ctx) => {
    const modelId = ctx.model?.id;
    const fragments = new Map<string, string>();

    if (modelId) {
      const block = loadModelPrompt(dir, modelId);
      if (block) fragments.set(`model:${modelId}`, block);
      // `model:` sorts before `prompt:`, so a model's own file always leads.
      for (const [key, text] of promptsForModel(dir, modelId)) fragments.set(key, text);
    }

    const request: PromptFragmentsRequest = {
      model: modelId,
      thinkingLevel: ctx.thinkingLevel,
      selectedTools: event.systemPromptOptions?.selectedTools,
      contribute(key, text) {
        const trimmedKey = typeof key === "string" ? key.trim() : "";
        const trimmedText = typeof text === "string" ? text.trim() : "";
        if (!trimmedKey || !trimmedText) return;
        fragments.set(trimmedKey, trimmedText);
      },
    };
    // Contributors may be absent, may throw, or may be from another version;
    // a broken contributor must not take the turn down with it.
    try {
      pi.events.emit(PROMPT_FRAGMENTS_CHANNEL, request);
    } catch (error) {
      console.error(`pi-model-prompts: fragment contributor failed: ${String(error)}`);
    }

    lastRun = {
      modelId,
      fragments: [...fragments.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, text]) => ({ key, chars: text.length })),
    };
    if (fragments.size === 0) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${assembleFragments(fragments)}` };
  });

  pi.registerCommand("model-prompt", {
    description: "Show injected system-prompt fragments; `settings` binds a prompt to models",
    getArgumentCompletions: modelPromptArgumentCompletions,
    handler: async (args, ctx) => {
      if (args.trim() === SETTINGS_SUBCOMMAND) {
        await openSettings(ctx, dir, ctx.model?.id);
        return;
      }
      const report = buildReport(dir, ctx.model?.id, lastRun);
      if (ctx.mode === "tui" && ctx.hasUI) {
        await showTextPanel(ctx, { title: "Model prompts", body: report, format: "plain" });
      } else {
        ctx.ui.notify(report, "info");
      }
    },
  });
}
