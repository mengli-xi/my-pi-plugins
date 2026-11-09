import assert from "node:assert/strict";
import test from "node:test";
import { click } from "./native-mouse.ts";

import {
  type ExtensionAPI,
  type ToolRendererResolver,
  type ToolRenderers,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { DEFAULT_NATIVE_TOOL_OUTPUT } from "../src/config.ts";
import {
  FoldedResultComponent,
  foldOutput,
  installFoldedNativeOutput,
  outputHeading,
  resultText,
} from "../src/native-output.ts";
import type { TextOpener } from "../src/openers.ts";

const plainTheme = { fg: (_c: string, text: string) => text } as unknown as Theme;

const lines = (component: Component, width = 60) =>
  component.render(width).map((line) => line.trimEnd());

class Fixed implements Component {
  private readonly output: string[];
  constructor(output: string[]) {
    this.output = output;
  }
  render(): string[] {
    return this.output;
  }
  invalidate(): void {}
}

function folded(
  output: string[],
  overrides: Partial<{ maxLines: number; body: string }> = {},
  openText: TextOpener = () => false,
) {
  return new FoldedResultComponent(new Fixed(output), {
    maxLines: overrides.maxLines ?? 2,
    heading: "Process · output",
    body: overrides.body ?? output.join("\n"),
    getTheme: () => plainTheme,
    openText,
  });
}

test("output that already fits is left exactly as the tool drew it", () => {
  assert.equal(foldOutput(["one", "two"], 2), undefined);
  assert.deepEqual(lines(folded(["one", "two"])), ["one", "two"]);
});

test("blank rows are spent before content is", () => {
  // Three rows, but only two carry anything: the fold is the content.
  assert.deepEqual(foldOutput(["head", "", "tail"], 2), {
    lines: ["head", "tail"],
    hidden: 0,
  });
  assert.deepEqual(lines(folded(["head", "", "tail"])), ["head", "tail"]);
});

test("a long result keeps the rows it can and says what it dropped", () => {
  const output = ["Started \"backend\"", "", ...Array.from({ length: 40 }, (_, i) => `log ${i}`)];
  const result = foldOutput(output, 2);

  assert.deepEqual(result?.lines, ["Started \"backend\""]);
  assert.equal(result?.hidden, 40);
  assert.deepEqual(lines(folded(output)), [
    "Started \"backend\"",
    "… +40 lines · click to view",
  ]);
});

test("the hint sits under the row it summarises", () => {
  const output = ["  ⎿ Output:", "  line a", "  line b", "  line c"];
  assert.deepEqual(lines(folded(output)), ["  ⎿ Output:", "  … +3 lines · click to view"]);
});

test("a wider cap keeps more rows, still counting the hint row", () => {
  const output = Array.from({ length: 10 }, (_, i) => `row ${i}`);
  const drawn = lines(folded(output, { maxLines: 4 }));

  assert.equal(drawn.length, 4);
  assert.deepEqual(drawn.slice(0, 3), ["row 0", "row 1", "row 2"]);
  assert.match(drawn[3] ?? "", /\+7 lines/);
});

test("a click opens the full output, whether or not this row hid any of it", () => {
  const opened: Array<{ heading: string; body: string; format?: string }> = [];
  const openText: TextOpener = (heading, body, options) => {
    opened.push({ heading, body, format: options?.format });
    return true;
  };

  // The tool collapses its own result long before the cap applies, so a row
  // that fits is still a summary of something.
  const short = folded(["one", "two"], { body: "one\ntwo\nand more" }, openText);
  short.render(60);
  assert.equal(click(short, 0, 0), true);

  const long = folded(["head", "a", "b", "c"], { body: "head\na\nb\nc" }, openText);
  long.render(60);
  assert.equal(click(long, 0, 0), true);
  assert.deepEqual(opened.map((entry) => entry.format), ["plain", "plain"]);
  assert.deepEqual(opened[1], {
    heading: "Process · output",
    body: "head\na\nb\nc",
    format: "plain",
  });
});

test("the popup is handed the tool's own expanded rendering", () => {
  let handed: ((width: number, theme: Theme) => string[]) | undefined;
  const openText: TextOpener = (_heading, _body, options) => {
    handed = options?.renderBody;
    return true;
  };

  const drew: Array<{ expanded?: boolean; width: number }> = [];
  const row = new FoldedResultComponent(new Fixed(["summary"]), {
    maxLines: 2,
    heading: "Process · output",
    body: "raw text",
    renderExpanded: (width) => {
      drew.push({ expanded: true, width });
      return ["full", "output", "with colour"];
    },
    getTheme: () => plainTheme,
    openText,
  });

  row.render(60);
  assert.equal(click(row, 0, 0), true);
  assert.ok(handed, "the popup was given a renderer");
  assert.deepEqual(handed?.(80, plainTheme), ["full", "output", "with colour"]);
  assert.deepEqual(drew, [{ expanded: true, width: 80 }]);
});

test("a click with no popup armed is declined", () => {
  const row = folded(["head", "a", "b", "c"]);
  row.render(60);
  assert.equal(click(row, 0, 0), false);
});

test("the popup is titled with the tool and the action it was given", () => {
  assert.equal(outputHeading("Process", { action: "output", id: "p1" }), "Process · output");
  assert.equal(outputHeading("Process", {}), "Process");
  assert.equal(outputHeading("Process", undefined), "Process");
  assert.equal(outputHeading("Process", { action: 12 }), "Process");
});

test("the popup carries the text blocks the model was given", () => {
  assert.equal(
    resultText([
      { type: "text", text: "line one" },
      { type: "image", data: "…" },
      { type: "text", text: "line two\n" },
    ]),
    "line one\nline two",
  );
  assert.equal(resultText(undefined), "");
});

function harness(config = DEFAULT_NATIVE_TOOL_OUTPUT) {
  let resolver: ToolRendererResolver | undefined;
  const pi = { registerToolRenderer(value: ToolRendererResolver) { resolver = value; } } as ExtensionAPI;
  const dispose = installFoldedNativeOutput(pi, config, () => plainTheme);
  const native = { renderShell: "default" as const, renderResult: () => new Fixed(["a", "b", "c", "d"]) };
  return { resolve: (name: string) => resolver?.(name, () => native) ?? native, native, dispose };
}
const context = { args: { action: "output" }, durationMs: undefined, outputPad: 0 } as Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];

test("public resolver folds configured tools and delegates after disposal", () => {
  const h = harness();
  const renderer = h.resolve("process");
  assert.equal(renderer.renderShell, "self");
  assert.ok(renderer.renderResult?.({ content: [], details: undefined }, { expanded: false, isPartial: false }, plainTheme, context) instanceof FoldedResultComponent);
  assert.equal(h.resolve("bash"), h.native);
  assert.notEqual(h.resolve("PROCESS"), h.native);
  h.dispose();
  assert.equal(h.resolve("process"), h.native);
});

test("Ctrl+O and compactShell retain their configured behavior", () => {
  const h = harness({ ...DEFAULT_NATIVE_TOOL_OUTPUT, respectExpanded: true, compactShell: false });
  const renderer = h.resolve("process");
  assert.equal(renderer.renderShell, "default");
  assert.ok(renderer.renderResult?.({ content: [], details: undefined }, { expanded: true, isPartial: false }, plainTheme, context) instanceof Fixed);
  assert.ok(renderer.renderResult?.({ content: [], details: undefined }, { expanded: false, isPartial: false }, plainTheme, context) instanceof FoldedResultComponent);
  h.dispose();
});

test("disabled and empty fold policies do not register a resolver", () => {
  for (const config of [{ ...DEFAULT_NATIVE_TOOL_OUTPUT, enabled: false }, { ...DEFAULT_NATIVE_TOOL_OUTPUT, tools: [] }]) {
    let registered = false;
    const pi = { registerToolRenderer() { registered = true; } } as unknown as ExtensionAPI;
    installFoldedNativeOutput(pi, config, () => plainTheme)();
    assert.equal(registered, false);
  }
});
