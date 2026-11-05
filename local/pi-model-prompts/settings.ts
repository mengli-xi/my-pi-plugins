/**
 * `/model-prompt settings` — pick a prompt, then tick the models it applies to.
 *
 * Prompt-first rather than model-first: the case this exists for is one
 * calibration file spread across several models, which model-first turns into
 * one visit per model. The legacy `<model-id>.md` files are deliberately not
 * listed here; they keep matching by file name and stay visible in the
 * `/model-prompt` report, so the two mechanisms never fight over one file.
 *
 * Rows come from the public runtime model registry, plus already-bound and
 * current model ids. No credential/config file discovery is needed here.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { showEditorPanel } from "pi-li-uikit/editor-panel";
import { MultiSelectTable, type MultiSelectTableRow } from "pi-li-uikit/multi-select-table";
import { searchSelectScreen } from "pi-li-uikit/search-select";

import {
  getBindingsSnapshot,
  listModels,
  listPrompts,
  type ModelEntry,
  type PromptEntry,
  PROMPTS_SUBDIR,
  saveBindings,
} from "./bindings.ts";

type ColumnId = "model" | "provider" | "prompts";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Every model the table must show: configured, already bound, or live. */
function tableModels(
  configured: readonly ModelEntry[],
  bound: readonly string[],
  currentModelId: string | undefined,
): ModelEntry[] {
  const known = new Set(configured.map((model) => model.id));
  const extras: ModelEntry[] = [];
  for (const id of [...bound, ...(currentModelId ? [currentModelId] : [])]) {
    if (known.has(id)) continue;
    known.add(id);
    extras.push({ id, providers: [], label: id });
  }
  return [...configured, ...extras.sort((a, b) => (a.id < b.id ? -1 : 1))];
}

async function pickPrompt(
  ctx: ExtensionCommandContext,
  prompts: readonly PromptEntry[],
): Promise<PromptEntry | undefined> {
  if (prompts.length === 1) return prompts[0];
  let picked: PromptEntry | undefined;
  await showEditorPanel(ctx, {
    initialScreen: "prompts" as const,
    maxVisible: 12,
    getScreen: () => searchSelectScreen({
      id: "prompts" as const,
      title: "Bind a prompt to models",
      breadcrumbs: [],
      statusLine:
        `${plural(prompts.length, "prompt", "prompts")} in ${PROMPTS_SUBDIR}/ · `
        + "legacy <model-id>.md files keep matching by name and are listed in /model-prompt",
      choices: prompts.map((prompt) => ({
        value: prompt.name,
        label: prompt.name,
        rightText: `${prompt.chars} chars`,
        description: prompt.models.length === 0
          ? "not bound"
          : plural(prompt.models.length, "model", "models"),
        detail: prompt.models.length === 0 ? undefined : prompt.models.join(", "),
      })),
      onPick: (name, context) => {
        picked = prompts.find((prompt) => prompt.name === name);
        context.transition({ kind: "close" });
      },
    }),
  });
  return picked;
}

async function pickModels(
  ctx: ExtensionCommandContext,
  prompt: PromptEntry,
  rows: readonly MultiSelectTableRow<string, ColumnId>[],
  initialSelectedIds: readonly string[],
): Promise<string[] | undefined> {
  let saved: string[] | undefined;
  const overlay = createEditorOverlayMount();
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const table = new MultiSelectTable<string, ColumnId>({
      tui,
      theme,
      keybindings,
      // The component's own footer says "Enter open / d delete"; the title is
      // the one place this panel can state what those keys mean here.
      title: `${prompt.name} — Space toggles · Enter saves · d unbinds`,
      columns: [
        { id: "model", header: "Model", minWidth: 12, grow: 2 },
        { id: "provider", header: "Provider", minWidth: 8 },
        { id: "prompts", header: "Other prompts", minWidth: 8, grow: 1 },
      ],
      rows,
      initialSelectedIds,
      maxVisible: 14,
      onAction: (action) => {
        if (action.kind === "activate") saved = [...table.selected];
        else if (action.kind === "delete") {
          const removed = new Set(action.ids);
          saved = table.selected.filter((id) => !removed.has(id));
        } else if (action.kind === "inspect") return;
        done();
      },
    });
    return overlay.mount(tui, table);
  }, overlay.customOptions);
  return saved;
}

export async function openSettings(
  ctx: ExtensionCommandContext,
  dir: string,
  currentModelId: string | undefined,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/model-prompt settings requires Pi's interactive TUI.", "warning");
    return;
  }

  const snapshot = getBindingsSnapshot(dir);
  if (snapshot.error) {
    ctx.ui.notify(snapshot.error.message, "warning");
    return;
  }
  const prompts = listPrompts(dir);
  if (prompts.length === 0) {
    ctx.ui.notify(
      `No bindable prompts yet. Create one at ${dir}/${PROMPTS_SUBDIR}/<name>.md, then run /model-prompt settings.`,
      "warning",
    );
    return;
  }

  const prompt = await pickPrompt(ctx, prompts);
  if (!prompt) return;

  const bindings = snapshot.bindings;
  const bound = bindings[prompt.name] ?? [];
  const models = tableModels(listModels(ctx.modelRegistry.getAll()), bound, currentModelId);
  if (models.length === 0) {
    ctx.ui.notify("No runtime, bound or current models available.", "warning");
    return;
  }

  const otherPrompts = new Map<string, string[]>();
  for (const [name, ids] of Object.entries(bindings)) {
    if (name === prompt.name) continue;
    for (const id of ids) otherPrompts.set(id, [...(otherPrompts.get(id) ?? []), name]);
  }

  const rows = models.map((model): MultiSelectTableRow<string, ColumnId> => ({
    id: model.id,
    cells: {
      model: model.id,
      provider: model.providers.join(", ") || "—",
      prompts: (otherPrompts.get(model.id) ?? []).join(", ") || "—",
    },
    current: model.id === currentModelId,
  }));

  const selected = await pickModels(ctx, prompt, rows, bound);
  if (!selected) return;

  try {
    saveBindings(dir, { ...bindings, [prompt.name]: selected }, snapshot.version);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : "Unable to save bindings.", "warning");
    return;
  }
  ctx.ui.notify(
    selected.length === 0
      ? `${prompt.name}: unbound from every model.`
      : `${prompt.name}: bound to ${plural(selected.length, "model", "models")} — ${selected.join(", ")}`,
    "info",
  );
}
