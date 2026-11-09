import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  createSkillAutocompleteProvider,
  DraftSkillBindings,
  extractSkillPrefix,
} from "../autocomplete.ts";
import { resolveSkillMentions, type SkillRef } from "../skills.ts";

const duplicateSkills: SkillRef[] = [
  { name: "deploy", path: "/user/deploy/SKILL.md", scope: "user" },
  { name: "deploy", path: "/project/deploy/SKILL.md", scope: "project" },
];

const fallback: AutocompleteProvider = {
  getSuggestions: async () => null,
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

test("prefix supports bare names and rejects bracket syntax", () => {
  assert.equal(extractSkillPrefix("Use $dep"), "$dep");
  assert.equal(extractSkillPrefix("Use $plugin:dep"), "$plugin:dep");
  assert.equal(extractSkillPrefix("Use $[dep"), undefined);
});

test("completion inserts $name and retains the exact selected path", async () => {
  const bindings = new DraftSkillBindings();
  const provider = createSkillAutocompleteProvider(fallback, () => duplicateSkills, bindings);
  const suggestions = await provider.getSuggestions(["Use $dep"], 0, 8, {} as never);
  assert.ok(suggestions);
  const project = suggestions.items.find((item) => item.description?.startsWith("Project"));
  assert.ok(project);
  assert.match(project.description ?? "", /\/project\/deploy\/SKILL\.md/);
  const completed = provider.applyCompletion(["Use $dep"], 0, 8, project, suggestions.prefix);
  assert.equal(completed.lines.join("\n"), "Use $deploy ");
  const exact = bindings.takeForSubmission("Use $deploy ");
  assert.deepEqual(resolveSkillMentions("Use $deploy ", duplicateSkills, exact).skills.map((skill) => skill.path), [
    "/project/deploy/SKILL.md",
  ]);
});

test("completion awaits an on-demand refreshed skill catalog", async () => {
  const bindings = new DraftSkillBindings();
  let skills: SkillRef[] = [];
  const provider = createSkillAutocompleteProvider(fallback, async () => skills, bindings);

  assert.equal(await provider.getSuggestions(["Use $hot"], 0, 8, {} as never), null);

  skills = [{ name: "hot-skill", path: "/user/hot-skill/SKILL.md", scope: "user" }];
  const suggestions = await provider.getSuggestions(["Use $hot"], 0, 8, {} as never);
  assert.ok(suggestions);
  assert.deepEqual(suggestions.items.map((item) => item.label), ["hot-skill"]);
});

test("editing through a binding drops it instead of pointing at the wrong token", () => {
  const bindings = new DraftSkillBindings();
  bindings.applyCompletion("$dep", "$deploy ", 0, 4, duplicateSkills[0]);
  assert.deepEqual(bindings.takeForSubmission("$destroy "), []);
});
