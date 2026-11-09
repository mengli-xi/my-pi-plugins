import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { claudeIndicatorPalette } from "../src/cyber-style.ts";

const THEME_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "themes",
  "cc-style-soft.json",
);

const theme = JSON.parse(readFileSync(THEME_PATH, "utf8")) as {
  name?: string;
  vars?: Record<string, unknown>;
  colors?: Record<string, unknown>;
};

test("the shipped theme keeps the name pi resolves it by", () => {
  // Themes are keyed by the `name` field, not the filename, and
  // `settings.json` names this one. Renaming it silently unsets the theme.
  assert.equal(theme.name, "cc-style-soft");
});

test("every colour slot resolves to a declared var or a literal", () => {
  const vars = theme.vars ?? {};
  const colors = theme.colors ?? {};
  assert.ok(Object.keys(colors).length > 0, "主题没有任何颜色槽");
  for (const [slot, value] of Object.entries(colors)) {
    if (typeof value !== "string") continue;
    // Empty means "no colour here", which is a real choice: `userMessageBg` is
    // blank because the user-message patch draws a border instead of a filled
    // block, and a background behind that border would defeat it.
    if (value === "") continue;
    // Otherwise a slot either names a var or carries its own literal. A name
    // that is neither is a typo pi resolves to nothing.
    if (value.startsWith("#") || /^\d+$/.test(value)) continue;
    assert.ok(
      Object.hasOwn(vars, value),
      `颜色槽 ${slot} 指向不存在的变量 ${value}`,
    );
  }
});

test("every var is an ANSI-256 index, not a hex literal", () => {
  // This terminal runs in 256-colour mode, so chalk quantises truecolour on
  // the way out and the result is not the colour that was written. The theme
  // was converted to indices for that reason; a hex value creeping back in
  // would shift colours without failing anything.
  for (const [name, value] of Object.entries(theme.vars ?? {})) {
    assert.equal(
      typeof value,
      "number",
      `变量 ${name} 不是 ANSI-256 序号（值为 ${JSON.stringify(value)}）`,
    );
    assert.ok(
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255,
      `变量 ${name} 超出 ANSI-256 范围: ${value}`,
    );
  }
});

test("the working row's base colour is the theme's Claude colour", () => {
  // The spinner paints itself rather than going through the theme — pi's
  // `accent` drives 61 other sites, so it could not be used for this. That
  // makes the two definitions independent, and this is what keeps them equal.
  const claudeVar = (theme.vars ?? {}).claude;
  assert.equal(
    claudeIndicatorPalette.base,
    `\x1b[38;5;${claudeVar}m`,
    "cyber-style.ts 的 shimmer 基色与主题的 claude 变量不一致",
  );
});

test("selectedBg remains available to non-selector badges", () => {
  assert.equal(
    (theme.vars ?? {}).selectionBg,
    66,
    "the shared badge background should keep its original blue tone",
  );
  assert.equal((theme.colors ?? {}).selectedBg, "selectionBg");
});

test("the live-process tone resolves to blue instead of lavender", () => {
  assert.equal((theme.vars ?? {}).blue, 75);
  assert.equal((theme.colors ?? {}).mdLink, "blue");
});
