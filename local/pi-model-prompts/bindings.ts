/**
 * Prompt-to-model bindings — the configurable half of pi-model-prompts.
 *
 * The original mechanism keys a prompt file by model id, which makes one
 * prompt serve several models only through symlinks. That still works and is
 * untouched. This layer adds the other direction: a prompt named for what it
 * does (`prompts/zh-writing.md`) plus a `bindings.json` recording which model
 * ids it applies to, so `/model-prompt settings` can toggle a model on or off
 * without anyone hand-editing file names.
 *
 * Both mechanisms feed the same fragment map in index.ts, under distinct key
 * prefixes (`model:` for the legacy file, `prompt:` for a binding), so the
 * single-owner assembly and its deterministic key ordering are preserved.
 *
 * No UI imports here: node's test runner loads this file directly.
 */
import { join } from "node:path";
import { markdownNames, readPrompt, readTextSnapshot, reportStorageError, type Snapshot, writeTextAtomic } from "./storage.ts";

export const PROMPTS_SUBDIR = "prompts";
export const BINDINGS_FILE = "bindings.json";

/** Prompt name to the model ids it is bound to. */
export type Bindings = Record<string, string[]>;

export interface PromptEntry {
  name: string;
  file: string;
  chars: number;
  /** Model ids currently bound, sorted. */
  models: string[];
}

export interface ModelEntry {
  id: string;
  /** Providers offering this id; an id served by two providers lists both. */
  providers: string[];
  label: string;
}

/**
 * Prompt names become file names, so anything that could climb out of the
 * prompts directory is rejected rather than sanitised — a silently rewritten
 * name would bind a prompt the user never picked.
 */
export function isSafePromptName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false;
  if (name.startsWith(".")) return false;
  return !/[/\\]/.test(name);
}

export function promptPath(dir: string, name: string): string {
  return join(dir, PROMPTS_SUBDIR, `${name}.md`);
}

export interface BindingsSnapshot {
  version: string;
  bindings: Bindings;
  error?: Error;
}

const parsedBindings = new WeakMap<Snapshot<string>, BindingsSnapshot>();

function normalizeBindings(value: unknown): { bindings: Bindings; invalid: boolean } {
  const bindings: Bindings = Object.create(null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { bindings, invalid: true };
  let invalid = false;
  for (const name of Object.keys(value).sort()) {
    const ids = (value as Record<string, unknown>)[name];
    if (!isSafePromptName(name) || !Array.isArray(ids)) {
      invalid = true;
      continue;
    }
    const valid = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (valid.length !== ids.length) invalid = true;
    if (valid.length > 0) bindings[name] = [...new Set(valid)].sort();
  }
  return { bindings, invalid };
}

/** A detached snapshot; malformed versions are readable but never writable. */
export function getBindingsSnapshot(dir: string): BindingsSnapshot {
  const file = readTextSnapshot(join(dir, BINDINGS_FILE));
  let cached = parsedBindings.get(file);
  if (!cached) {
    cached = { version: file.version, bindings: Object.create(null), error: file.error };
    if (file.value !== undefined) {
      try {
        const result = normalizeBindings(JSON.parse(file.value));
        cached.bindings = result.bindings;
        if (result.invalid) cached.error = new Error("bindings.json: invalid entries ignored; repair the file before saving.");
      } catch (error) {
        // JSON parser messages may quote private file contents; retain only the cause.
        cached.error = new Error("bindings.json: Invalid JSON; repair the file before saving.", { cause: error });
      }
    }
    parsedBindings.set(file, cached);
  }
  if (cached.error) reportStorageError(cached.error);
  const bindings: Bindings = Object.create(null);
  for (const [name, ids] of Object.entries(cached.bindings)) bindings[name] = [...ids];
  return { ...cached, bindings };
}

/** Read valid entries without exposing the parsed cache to caller mutation. */
export function loadBindings(dir: string): Bindings {
  return getBindingsSnapshot(dir).bindings;
}

/** Atomic save; no-op for canonical equality, and refuse stale or broken input files. */
export function saveBindings(dir: string, bindings: Bindings, expectedVersion?: string): void {
  const current = getBindingsSnapshot(dir);
  if (current.error) throw current.error;
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    throw new Error("bindings.json changed; reopen settings before saving.");
  }
  const pruned = normalizeBindings(bindings).bindings;
  const canonical = JSON.stringify(pruned, null, 2);
  if (canonical === JSON.stringify(current.bindings, null, 2)) return;
  writeTextAtomic(join(dir, BINDINGS_FILE), `${canonical}\n`, current.version);
}

/** Load one bindable prompt's text, or undefined when missing or empty. */
export function loadPrompt(dir: string, name: string): string | undefined {
  if (!isSafePromptName(name)) return undefined;
  return readPrompt(promptPath(dir, name));
}

/** Every prompt in prompts/, with the models each is bound to. */
export function listPrompts(dir: string): PromptEntry[] {
  const names = markdownNames(join(dir, PROMPTS_SUBDIR));
  const bindings = loadBindings(dir);
  const prompts: PromptEntry[] = [];
  for (const file of names.filter((name) => name.endsWith(".md")).sort()) {
    const name = file.slice(0, -3);
    if (!isSafePromptName(name)) continue;
    const snapshot = readTextSnapshot(join(dir, PROMPTS_SUBDIR, file));
    if (snapshot.error) reportStorageError(snapshot.error);
    if (snapshot.value === undefined) continue;
    prompts.push({ name, file, chars: snapshot.value.trim().length, models: bindings[name] ?? [] });
  }
  return prompts;
}

/**
 * Bound prompt blocks that apply to a model id, keyed `prompt:<name>`.
 * A binding naming a prompt whose file is gone or empty contributes nothing.
 */
export function promptsForModel(dir: string, modelId: string): Map<string, string> {
  const applied = new Map<string, string>();
  for (const [name, ids] of Object.entries(loadBindings(dir))) {
    if (!ids.includes(modelId)) continue;
    const block = loadPrompt(dir, name);
    if (block) applied.set(`prompt:${name}`, block);
  }
  return applied;
}

/** Runtime registry metadata only; no model-config or credential file reads. */
export function listModels(models: readonly { id: string; provider: string; name?: string }[]): ModelEntry[] {
  const byId = new Map<string, ModelEntry>();
  for (const model of models) {
    const existing = byId.get(model.id);
    if (existing) {
      if (!existing.providers.includes(model.provider)) existing.providers.push(model.provider);
    } else {
      byId.set(model.id, { id: model.id, providers: [model.provider], label: model.name || model.id });
    }
  }
  for (const model of byId.values()) model.providers.sort();
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
