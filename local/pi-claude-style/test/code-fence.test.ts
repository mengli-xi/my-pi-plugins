import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import {
  CodeFenceMarkerHidingComponent,
  isCodeFenceMarkerLine,
  withoutCodeFenceMarkers,
} from "../src/code-fence.ts";

// The original predicate is the behavior oracle, including marker-looking code
// body rows. Markdown fence parsing belongs to the child, not this filter.
function originalIsCodeFenceMarkerLine(line: string): boolean {
  const plain = line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return /^\s*```[^`]*\s*$/u.test(plain);
}

function originalFilter(lines: readonly string[]): string[] {
  return lines.filter((line) => !originalIsCodeFenceMarkerLine(line));
}

const examples: readonly [string, boolean][] = [
  ["", false],
  ["plain text", false],
  ["中文 body", false],
  ["`", false],
  ["``", false],
  ["```", true],
  ["```ts", true],
  ["  ```ts  ", true],
  ["\t ``` \t", true],
  ["\u00a0```sh", true],
  ["```中文", true],
  ["```ts extra", true],
  ["````", false],
  ["prefix ```", false],
  ["body `inline code`", false],
  ["```a`b", false],
  ["~~~", false],
  ["  ~~~ts", false],
  ["\x1b[31m`\x1b[0m``split-ansi", true],
  ["\x1b]8;;https://example.invalid\x1b\\```osc-st", true],
  ["\x1b]8;;https://example.invalid/```\x07body\x1b]8;;\x07", false],
];
const constructedRows = examples.flatMap(([line]) => [
  line,
  `\x1b[31m${line}\x1b[0m`,
  `\x1b]8;;https://example.invalid\x07${line}\x1b]8;;\x07`,
  `\x1b]8;;https://example.invalid\x1b\\${line}\x1b]8;;\x1b\\`,
]);

test("fast rejection is equivalent to the original predicate for constructed ANSI and OSC rows", () => {
  for (const [line, expected] of examples) {
    assert.equal(originalIsCodeFenceMarkerLine(line), expected, JSON.stringify(line));
    assert.equal(isCodeFenceMarkerLine(line), expected, JSON.stringify(line));
  }
  for (const line of constructedRows) {
    assert.equal(isCodeFenceMarkerLine(line), originalIsCodeFenceMarkerLine(line), JSON.stringify(line));
  }
});

test("withoutCodeFenceMarkers and the component produce equivalent rows", () => {
  let rows: string[] = [];
  const component = new CodeFenceMarkerHidingComponent({ render: () => [...rows], invalidate() {} });
  for (const next of [constructedRows, [], ["```ts", "const x = 1;", "```"], [...constructedRows].reverse()]) {
    rows = next;
    const expected = originalFilter(rows);
    assert.deepEqual(withoutCodeFenceMarkers(rows), expected);
    assert.deepEqual(component.render(80), expected);
    component.invalidate();
    assert.deepEqual(component.render(80), withoutCodeFenceMarkers(rows));
  }
});

test("reads actual rows on every render, including resize, theme and in-place mutations", () => {
  let renders = 0;
  let invalidations = 0;
  const rows = ["```mutable", "old body", "```", "after"];
  const component = new CodeFenceMarkerHidingComponent({
    render(width) { renders++; return width < 40 ? ["```narrow", "narrow body", "```"] : rows; },
    invalidate() { invalidations++; },
  });
  const check = (width = 80) => {
    const expected = originalFilter(width < 40 ? ["```narrow", "narrow body", "```"] : rows);
    assert.deepEqual(component.render(width), expected);
  };
  check();
  rows[0] = "not a fence";
  rows[1] = "```new marker";
  check();
  rows.splice(1, 1, "inserted", "\x1b[32mthemed body\x1b[0m");
  check();
  check(20);
  component.invalidate();
  assert.equal(invalidations, 1);
  check();
  rows.splice(0, rows.length);
  check();
  rows.push("\x1b]8;;https://example.invalid\x07```linked\x1b]8;;\x07", "late body");
  check();
  const output = component.render(80);
  output[0] = "caller mutation";
  check();
  assert.equal(renders, 9, "filtering never skips the child renderer");
});

test("streamed Markdown resolves changed opening fences through the unchanged suffix", () => {
  initTheme("dark");
  const markdown = new Markdown("", 0, 0, getMarkdownTheme());
  const component = new CodeFenceMarkerHidingComponent(markdown);
  for (const source of [
    "before\n\n```ts\nconst x = 1;",
    "before\n\n```ts\nconst x = 1;\nconst y = 2;\n``",
    "before\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\nafter **bold**",
    "before\n\nnot a fence\nconst x = 1;\nconst y = 2;\n```\n\nafter **bold**",
    "before\n\n~~~~\n```marker-looking code\n~~~~\n\nafter **bold**",
  ]) {
    markdown.setText(source);
    for (const width of [80, 19, 80]) {
      assert.deepEqual(component.render(width), originalFilter(markdown.render(width)));
    }
  }
  initTheme("light");
  component.invalidate();
  assert.deepEqual(component.render(80), originalFilter(markdown.render(80)));
  initTheme("dark");
});

test("CC filtering leaves an unrelated component's rows and ANSI bytes untouched", () => {
  const rows = ["```boundary", "\x1b[33mbody\x1b[0m", "```"];
  const native: Component = { render: () => rows, invalidate() {} };
  assert.deepEqual(new CodeFenceMarkerHidingComponent(native).render(80), [rows[1]]);
  assert.equal(native.render(80), rows);
  assert.deepEqual(native.render(80), ["```boundary", "\x1b[33mbody\x1b[0m", "```"]);
});
