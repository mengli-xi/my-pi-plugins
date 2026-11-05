/**
 * Pure report/lookup logic for pi-model-prompts, kept free of UI imports so
 * node's test runner can load it directly.
 */
import { join } from "node:path";
import { linkTarget, markdownNames, readPrompt, readTextSnapshot, reportStorageError } from "./storage.ts";

import { getBindingsSnapshot, listPrompts, loadBindings, PROMPTS_SUBDIR, promptsForModel } from "./bindings.ts";

export function promptFileName(modelId: string): string {
  return `${modelId.replaceAll("/", "_").replaceAll("\\", "_")}.md`;
}

/** Load the prompt block for a model id, or undefined when none applies. */
export function loadModelPrompt(dir: string, modelId: string): string | undefined {
  return readPrompt(join(dir, promptFileName(modelId)));
}

export interface FragmentRecord {
  key: string;
  chars: number;
}

export interface LastRun {
  modelId: string | undefined;
  fragments: FragmentRecord[];
}

/** Assemble collected fragments into the text appended to the system prompt. */
export function assembleFragments(fragments: Map<string, string>): string {
  return [...fragments.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, text]) => text)
    .join("\n\n");
}

export interface RuleEntry {
  file: string;
  modelId: string;
  chars: number;
  linkTarget?: string;
}

/** Every *.md rule in the prompts dir, sorted by file name. */
export function listRules(dir: string): RuleEntry[] {
  const names = markdownNames(dir);
  const rules: RuleEntry[] = [];
  for (const file of names.filter((name) => name.endsWith(".md")).sort()) {
    const path = join(dir, file);
    const snapshot = readTextSnapshot(path);
    if (snapshot.error) reportStorageError(snapshot.error);
    if (snapshot.value === undefined) continue;
    const entry: RuleEntry = { file, modelId: file.slice(0, -3), chars: snapshot.value.trim().length };
    const target = linkTarget(path);
    if (target !== undefined) entry.linkTarget = target;
    rules.push(entry);
  }
  return rules;
}

/** The full `/model-prompt` report: current-model status, injected content, all rules. */
export function buildReport(
  dir: string,
  modelId: string | undefined,
  lastRun: LastRun | undefined,
): string {
  const lines: string[] = [];

  if (!modelId) {
    lines.push("No model selected.");
  } else {
    const block = loadModelPrompt(dir, modelId);
    lines.push(`Model: ${modelId}`);
    const source = readTextSnapshot(join(dir, promptFileName(modelId)));
    lines.push(
      source.error
        ? `Rule: ${promptFileName(modelId)} — ${source.error.message}; no contribution from this source`
        : block
          ? `Rule: ${promptFileName(modelId)} (${block.length} chars) — appended to the system prompt on each agent run`
          : `Rule: ${promptFileName(modelId)} — missing or empty; nothing is injected`,
    );
  }

  if (!lastRun) {
    lines.push("Last run: no agent run yet in this session");
  } else if (lastRun.fragments.length === 0) {
    lines.push(`Last run: nothing injected for ${lastRun.modelId ?? "(no model)"}`);
  } else {
    const total = lastRun.fragments.reduce((sum, f) => sum + f.chars, 0);
    lines.push(
      `Last run: injected ${total} chars for ${lastRun.modelId ?? "(no model)"} — ` +
        lastRun.fragments.map((f) => `${f.key} (${f.chars})`).join(", "),
    );
  }

  lines.push("Last-run records contain this package's contribution keys/chars, not the final provider request.");
  const bindingsState = getBindingsSnapshot(dir);
  if (bindingsState.error) lines.push(`Bindings: ${bindingsState.error.message} (settings read-only)`);
  const bound = modelId ? promptsForModel(dir, modelId) : new Map<string, string>();
  if (modelId) {
    lines.push(
      bound.size === 0
        ? `Bound prompts: none — bind one with /model-prompt settings`
        : `Bound prompts: ${[...bound.keys()].map((key) => key.slice("prompt:".length)).join(", ")}`,
    );
  }

  const block = modelId ? loadModelPrompt(dir, modelId) : undefined;
  if (block) {
    lines.push("", "Current prompt source", "───────────────", block);
  }
  for (const [key, text] of bound) {
    lines.push("", `Current prompt source · ${key.slice("prompt:".length)}`, "───────────────", text);
  }

  const rules = listRules(dir);
  lines.push("", `All rules in ${dir}`, "─".repeat(Math.min(60, 13 + dir.length)));
  if (rules.length === 0) {
    lines.push("(none)");
  } else {
    for (const rule of rules) {
      const link = rule.linkTarget ? ` → ${rule.linkTarget}` : "";
      const current = modelId && rule.file === promptFileName(modelId) ? "  ← current model" : "";
      lines.push(`- ${rule.modelId} (${rule.file}${link}, ${rule.chars} chars)${current}`);
    }
  }
  const prompts = listPrompts(dir);
  const bindings = loadBindings(dir);
  lines.push("", `Bindable prompts in ${join(dir, PROMPTS_SUBDIR)}`, "─".repeat(40));
  if (prompts.length === 0) {
    lines.push("(none)");
  } else {
    for (const prompt of prompts) {
      const models = bindings[prompt.name] ?? [];
      const targets = models.length === 0 ? "unbound" : models.join(", ");
      const current = modelId && models.includes(modelId) ? "  ← applies to current model" : "";
      lines.push(`- ${prompt.name} (${prompt.chars} chars) → ${targets}${current}`);
    }
  }

  lines.push(
    "",
    "Package-contributed fragments arrive over the `prompt:fragments-v1` channel",
    "(see contracts.ts); the Last run line above names the ones that applied.",
  );
  return lines.join("\n");
}
