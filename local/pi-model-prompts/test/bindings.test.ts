import { after } from "node:test";
import { rmSync as removeFixtures } from "node:fs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  isSafePromptName,
  listModels,
  listPrompts,
  loadBindings,
  loadPrompt,
  promptsForModel,
  saveBindings,
} from "../bindings.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "test-fixtures-"));
after(() => removeFixtures(fixtureRoot, { recursive: true, force: true }));

function dirWithPrompt(name: string, body: string): string {
  const dir = mkdtempSync(join(fixtureRoot, "model-prompts-"));
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", `${name}.md`), body);
  return dir;
}

test("rejects prompt names that could escape the prompts directory", () => {
  assert.equal(isSafePromptName("zh-writing"), true);
  assert.equal(isSafePromptName("../escape"), false);
  assert.equal(isSafePromptName("a/b"), false);
  assert.equal(isSafePromptName(".hidden"), false);
  assert.equal(isSafePromptName(""), false);
});

test("missing or malformed bindings.json yields no bindings", () => {
  const dir = mkdtempSync(join(fixtureRoot, "model-prompts-"));
  assert.equal(Object.keys(loadBindings(dir)).length, 0);
  writeFileSync(join(dir, "bindings.json"), "{ not json");
  assert.equal(Object.keys(loadBindings(dir)).length, 0);
  writeFileSync(join(dir, "bindings.json"), '["array"]');
  assert.equal(Object.keys(loadBindings(dir)).length, 0);
});

test("loadBindings drops unsafe names, non-string ids and empty lists", () => {
  const dir = mkdtempSync(join(fixtureRoot, "model-prompts-"));
  writeFileSync(join(dir, "bindings.json"), JSON.stringify({
    "zh-writing": ["grok-4.6", 42, "grok-4.6", "model-a"],
    "../escape": ["grok-4.6"],
    empty: [],
    wrong: "not-an-array",
  }));
  assert.deepEqual({ ...loadBindings(dir) }, { "zh-writing": ["grok-4.6", "model-a"] });
});

test("saveBindings prunes empty prompts and round-trips sorted", () => {
  const dir = mkdtempSync(join(fixtureRoot, "model-prompts-"));
  saveBindings(dir, { b: ["z", "a", "a"], a: [], "../bad": ["x"] });
  assert.deepEqual({ ...loadBindings(dir) }, { b: ["a", "z"] });
});

test("listPrompts reports sizes and the models each prompt is bound to", () => {
  const dir = dirWithPrompt("zh-writing", "\n中文规范\n\n");
  writeFileSync(join(dir, "prompts", "notes.txt"), "ignored");
  saveBindings(dir, { "zh-writing": ["grok-4.6"] });
  assert.deepEqual(listPrompts(dir), [
    { name: "zh-writing", file: "zh-writing.md", chars: 4, models: ["grok-4.6"] },
  ]);
});

test("listPrompts is empty when the prompts directory is absent", () => {
  assert.deepEqual(listPrompts(mkdtempSync(join(fixtureRoot, "model-prompts-"))), []);
});

test("loadPrompt trims and treats a whitespace-only file as absent", () => {
  const dir = dirWithPrompt("zh-writing", "\n  block  \n");
  assert.equal(loadPrompt(dir, "zh-writing"), "block");
  writeFileSync(join(dir, "prompts", "blank.md"), "  \n");
  assert.equal(loadPrompt(dir, "blank"), undefined);
  assert.equal(loadPrompt(dir, "../escape"), undefined);
});

test("promptsForModel returns only prompts bound to that model", () => {
  const dir = dirWithPrompt("zh-writing", "写中文");
  writeFileSync(join(dir, "prompts", "terse.md"), "be terse");
  saveBindings(dir, { "zh-writing": ["grok-4.6", "glm-5.1"], terse: ["glm-5.1"] });
  assert.deepEqual([...promptsForModel(dir, "grok-4.6")], [["prompt:zh-writing", "写中文"]]);
  assert.deepEqual(
    [...promptsForModel(dir, "glm-5.1")].sort(),
    [["prompt:terse", "be terse"], ["prompt:zh-writing", "写中文"]],
  );
  assert.deepEqual([...promptsForModel(dir, "unbound")], []);
});

test("a binding whose prompt file is gone contributes nothing", () => {
  const dir = mkdtempSync(join(fixtureRoot, "model-prompts-"));
  saveBindings(dir, { ghost: ["grok-4.6"] });
  assert.deepEqual([...promptsForModel(dir, "grok-4.6")], []);
});

test("listModels uses runtime models, dedupes ids and keeps every provider", () => {
  assert.deepEqual(listModels([
    { id: "model-a", name: "Model A", provider: "provider-a" },
    { id: "model-b", provider: "provider-a" },
    { id: "model-a", provider: "provider-b" },
  ]), [
    { id: "model-a", providers: ["provider-a", "provider-b"], label: "Model A" },
    { id: "model-b", providers: ["provider-a"], label: "model-b" },
  ]);
  assert.deepEqual(listModels([]), []);
});
