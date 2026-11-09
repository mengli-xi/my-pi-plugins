// Run via isolated-agent.mjs: deterministic renderer work, with no provider/parser.
import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { GroupStore } from "../src/grouping.ts";

const { decorateToolRenderers } = await import(process.env.CC_WRITE_PREVIEW_MODULE ?? "../src/tool-renderer.ts");
const theme = { fg: (_color: string, text: string) => text };
for (const size of [50_000, 100_000, 200_000]) {
  const samples = [];
  let work = 0, invocations = 0;
  for (let repeat = 0; repeat < 3; repeat++) {
    let scanned = 0, calls = 0;
    const renderer = decorateToolRenderers("write", {
      renderCall(args: { path: string; content: string }) {
        scanned += args.content.length; calls++;
        // Representative native formatter: reads and serializes the displayed payload.
        return new Text(JSON.stringify(args), 0, 0);
      },
    }, { store: new GroupStore({ maxGroups: 10 }), resolvePresentation: () => ({ kind: "native" }),
      getExpandMode: () => "inline", maxResultChars: 10_000 });
    const ctx = { args: {}, toolCallId: "write", state: {}, lastComponent: undefined, invalidate() {}, cwd: "/tmp",
      argsComplete: false, executionStarted: false, expanded: true, showImages: false, isPartial: true, isError: false };
    const content = "中".repeat(size);
    const started = performance.now();
    for (let length = 64; length < size; length += 64) {
      ctx.args = { path: "report.txt", content: content.slice(0, length) };
      ctx.lastComponent = renderer.renderCall(ctx.args, theme, ctx);
    }
    ctx.argsComplete = true; ctx.args = { path: "report.txt", content };
    const final = renderer.renderCall(ctx.args, theme, ctx);
    samples.push(performance.now() - started);
    // Validate completeness outside the timed renderer bookkeeping.
    assert.deepEqual(final.render(112), new Text(JSON.stringify(ctx.args), 0, 0).render(112));
    work = scanned; invocations = calls;
  }
  console.log(JSON.stringify({ chars: size, medianMs: samples.sort((a, b) => a - b)[1], scannedChars: work, invocations }));
}
