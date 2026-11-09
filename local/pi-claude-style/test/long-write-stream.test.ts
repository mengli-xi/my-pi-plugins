import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { createWriteToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ToolRenderers, Theme } from "@earendil-works/pi-coding-agent";
import { GroupStore } from "../src/grouping.ts";
import { decorateToolRenderers } from "../src/tool-renderer.ts";
import { RunMetrics } from "../src/metrics.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
function context(state = {}): Parameters<NonNullable<ToolRenderers["renderCall"]>>[2] {
  return { args: {}, toolCallId: "write-long", state, lastComponent: undefined, invalidate() {},
    cwd: "/tmp", argsComplete: false, executionStarted: false, isPartial: true,
    expanded: true, showImages: false, isError: false, durationMs: undefined, outputPad: 0,
    keyText: () => "", keyHint: (_key, description) => description };
}

test("substitute formatter work stays linear and its final native/inline output remains complete", () => {
  for (const kind of ["native", "grouped"] as const) {
    const work: number[] = [];
    for (const size of [50_000, 100_000, 200_000]) {
      let scanned = 0, calls = 0;
      const original = (args: any) => { scanned += args.content.length; calls++; return new Text(args.content, 0, 0); };
      const store = new GroupStore({ maxGroups: 10 });
      const decorated = decorateToolRenderers("write", { renderCall: original }, {
        store, getExpandMode: () => "inline", resolvePresentation: () => ({ kind }), maxResultChars: 10_000,
      });
      const ctx = context();
      const content = "中文报告\n".repeat(Math.ceil(size / 5)).slice(0, size);
      let last;
      for (let length = 64; length < content.length; length += 64) {
        const args = { path: "report.txt", content: content.slice(0, length) };
        ctx.args = args;
        const component = decorated.renderCall!(args, theme, ctx);
        component.render(100);
        if (length > 4_160) assert.equal(component, last, "saturated preview must reuse its component");
        ctx.lastComponent = component; last = component;
        assert.equal(args.content.length, length, "source args must never be shortened");
      }
      assert.ok(calls <= 65, `full renderer called ${calls} times for ${size} chars`);
      const args = { path: "report.txt", content };
      ctx.args = args; ctx.argsComplete = true;
      const final = decorated.renderCall!(args, theme, ctx);
      const expected = new Text(content, 0, 0).render(kind === "native" ? 100 : 98);
      assert.deepEqual(final.render(100), kind === "native" ? expected : expected.map((line, i) => `${i ? "  " : "● "}${line}`));
      assert.ok(scanned < 140_000 + size, `preview rescanned ${scanned} chars`);
      work.push(scanned);
    }
    assert.ok(work[2]! < work[0]! * 2.5, JSON.stringify(work));
  }
});

// Recorded from the real Pi 1.4.0 renderer + 7405261 decorator using the review
// probe sequence below. RLE only removes duplicate lines; assertions compare
// every expanded line, normalizing terminal styling/link escapes and padding.
const baseline = JSON.parse(readFileSync(new URL("./fixtures/long-write-final-7405261.json", import.meta.url), "utf8"));
const actualRows = (component: Component) => component.render(100).map(line =>
  line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").trimEnd()
);

for (const kind of ["native", "grouped"] as const) {
  test(`real Pi write ${kind === "grouped" ? "inline" : "native"} preserves the baseline through completion/result/invalidate`, async () => {
    initTheme("dark");
    // Like Pi's renderer resolver, accept partial/unknown args while streaming;
    // the tool definition's static schema describes only complete execution args.
    const real = createWriteToolDefinition("/tmp") as unknown as ToolRenderers;
    const store = new GroupStore({ maxGroups: 10 });
    let callChild: Component | undefined, resultChild: Component | undefined;
    const errors: unknown[] = [];
    const definition: ToolRenderers = {
      ...real,
      renderCall(args, theme, ctx) {
        try {
          assert.equal(ctx.lastComponent, callChild, "native call must receive its own previous child");
          callChild = real.renderCall!(args, theme, ctx);
          return callChild;
        } catch (error) { errors.push(error); throw error; }
      },
      renderResult(result, options, theme, ctx) {
        try {
          assert.equal(ctx.lastComponent, resultChild, "native result must receive its own previous child");
          resultChild = real.renderResult!(result, options, theme, ctx);
          return resultChild;
        } catch (error) { errors.push(error); throw error; }
      },
    };
    const decorated = decorateToolRenderers("write", definition, {
      store, getExpandMode: () => "inline", resolvePresentation: () => ({ kind }), maxResultChars: 10_000,
    });
    const row = new ToolExecutionComponent("write", "inline-probe", {}, { showImages: false }, decorated,
      { requestRender() {} } as TUI, "/tmp");
    const content = '中文报告："引号"与反斜杠\\\n'.repeat(400).slice(0, 5000);
    row.setExpanded(true);
    for (const length of [64, 4096, 4160, 5000]) {
      row.updateArgs({ path: "report.txt", content: content.slice(0, length) });
      row.render(100);
    }
    const expected = baseline.cases[kind].runs.flatMap((run: { count: number; line: string }) => Array(run.count).fill(run.line));
    assert.equal(expected.length, baseline.cases[kind].rows);
    row.setArgsComplete();
    assert.deepEqual(actualRows(row), expected, "argsComplete must restore every baseline line");
    store.start("inline-probe", "write", { path: "report.txt", content });
    row.markExecutionStarted();
    assert.deepEqual(actualRows(row), expected, "execution start must keep the full call");
    store.end("inline-probe", { text: "Successfully wrote to report.txt", isError: false, truncated: false }, "completed");
    row.updateResult({ content: [{ type: "text", text: "Successfully wrote to report.txt" }], isError: false }, false);
    assert.deepEqual(actualRows(row), expected, "completed result must match 7405261");
    await Promise.resolve(); // drain GroupStore's public invalidation callbacks
    row.invalidate();
    assert.deepEqual(actualRows(row), expected, "invalidate must retain the completed baseline rendering");
    assert.deepEqual(errors, [], "Pi must never have to swallow a renderer error or fall back");
  });
}

test("bounded write preview does not end inside an emoji or supplementary Han surrogate pair", () => {
  for (const pair of ["😀", "𠮷"]) {
    let preview = "";
    const decorated = decorateToolRenderers("write", { renderCall(args: any) { preview = args.content; return new Text(preview, 0, 0); } }, {
      store: new GroupStore({ maxGroups: 10 }), getExpandMode: () => "inline",
      resolvePresentation: () => ({ kind: "native" }), maxResultChars: 10_000,
    });
    const ctx = context(), content = "中".repeat(4095) + pair + "完整尾部";
    decorated.renderCall!({ content }, theme, ctx);
    assert.equal(preview, `${"中".repeat(4095)}\n…`);
    ctx.argsComplete = true;
    decorated.renderCall!({ content }, theme, ctx);
    assert.equal(preview, content);
  }
});

test("folded rows reuse their summary through argument deltas and still reflect final status", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const decorated = decorateToolRenderers("write", {}, {
    store, getExpandMode: () => "overlay", resolvePresentation: () => ({ kind: "grouped" }), maxResultChars: 10_000,
  });
  const ctx = context();
  const first = decorated.renderCall!({ path: "report.txt" }, theme, ctx);
  for (let length = 0; length < 200_000; length += 128) {
    const current = decorated.renderCall!({ path: "report.txt", content: "中".repeat(length) }, theme, ctx);
    assert.equal(current, first);
  }
  store.end(ctx.toolCallId, { text: "ok", isError: false, truncated: false }, "completed");
  assert.deepEqual(first.render(100).map(line => line.trimEnd()), ["  Wrote 1 file"]);
  store.clear();
  assert.equal(decorated.renderCall!({}, theme, ctx), first);
  assert.ok(store.getByToolCallId(ctx.toolCallId), "component reuse must not bypass a reset store");
  const other = decorated.renderCall!({}, theme, context());
  assert.notEqual(other, first, "SDK rows must not share a component cache");
});

test("preview refreshes after path changes, shrinking args, expansion and completion", () => {
  let calls = 0;
  const decorated = decorateToolRenderers("write", { renderCall: args => { calls++; return new Text(JSON.stringify(args), 0, 0); } }, {
    store: new GroupStore({ maxGroups: 10 }), getExpandMode: () => "overlay",
    resolvePresentation: () => ({ kind: "native" }), maxResultChars: 10_000,
  });
  const ctx = context(), args = { path: "a", content: "中".repeat(10_000) };
  decorated.renderCall!(args, theme, ctx);
  decorated.renderCall!({ ...args, content: args.content + "尾部" }, theme, ctx);
  assert.equal(calls, 1);
  decorated.renderCall!({ ...args, path: "b" }, theme, ctx);
  assert.equal(calls, 2);
  ctx.expanded = false; decorated.renderCall!({ ...args, path: "b" }, theme, ctx);
  assert.equal(calls, 3);
  decorated.renderCall!({ ...args, content: "短内容" }, theme, ctx);
  assert.equal(calls, 4);
  ctx.argsComplete = true;
  const final = decorated.renderCall!(args, theme, ctx);
  assert.equal(calls, 5);
  assert.deepEqual(final.render(100), new Text(JSON.stringify(args), 0, 0).render(100));
});

test("Chinese tool argument TPS follows a slowdown instead of retaining the preceding rate", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now }); metrics.start(); metrics.startTurn();
  const partial = { role: "assistant" as const, content: [], api: "openai-responses", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse" as const, timestamp: 0 };
  const delta = () => metrics.handleAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: "中".repeat(79), partial });
  delta();
  for (let i = 0; i < 6; i++) { now += 1000; delta(); }
  assert.equal(Math.round(metrics.snapshot().tps!), 79);
  for (let i = 0; i < 4; i++) { now += 2000; delta(); }
  assert.equal(metrics.snapshot().tps, 39.5);
  assert.equal(metrics.snapshot().outputEstimated, true);
});
