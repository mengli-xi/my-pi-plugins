// Test instrumentation only. Never logs transcript text or sends a prompt.
import { appendFileSync } from "node:fs";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { fauxProvider } from "@earendil-works/pi-ai";

export default function historyMeasurements(pi) {
  pi.registerProvider(fauxProvider({ provider: "history-fixture", api: "history-fixture-api", models: [{ id: "offline", name: "offline", contextWindow: 200000, maxTokens: 4096 }] }).provider);
  let tui, ctx, mode, stage = "open", rendered = false, firstFrameMs;
  const frames = new Map();
  let peakRss = 0;
  const output = data => appendFileSync(process.env.CC_HISTORY_METRICS, `${JSON.stringify(data)}\n`);
  const prototype = InteractiveMode.prototype;
  const append = prototype.addMessageToChat;
  prototype.addMessageToChat = function (...args) {
    mode = this;
    const result = append.apply(this, args);
    rendered = true;
    return result;
  };
  const original = TuiAltScreen.prototype.doRender;
  TuiAltScreen.prototype.doRender = function (...args) {
    const start = performance.now();
    const result = original.apply(this, args);
    const ms = performance.now() - start;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const samples = frames.get(stage) ?? [];
    samples.push(ms); frames.set(stage, samples);
    if (rendered && firstFrameMs === undefined) firstFrameMs = Date.now() - Number(process.env.CC_HISTORY_STARTED);
    return result;
  };
  const hidden = () => {
    for (const component of mode?.chatContainer.children.slice(0, 8) ?? []) {
      const match = component.render(120).join("\n").match(/加载更早的 (\d+) 条记录/u);
      if (match) return Number(match[1]);
    }
    return 0;
  };
  const measure = label => {
    const samples = [...(frames.get(stage) ?? [])].sort((a, b) => a - b);
    const components = mode?.chatContainer.children ?? [];
    const anchors = components.filter(component => component[Symbol.for("pi.claude-style.history-anchor.v1")] === 1);
    output({ label, firstFrameMs, hidden: hidden(), entries: ctx?.sessionManager.getBranch().length,
      components: components.length, anchors: anchors.length, anchoredRows: anchors.reduce((sum, component) => sum + component.render(120).length, 0),
      memory: process.memoryUsage(), frames: { count: samples.length,
        p50: samples[Math.floor(samples.length * .5)] ?? 0, p95: samples[Math.floor(samples.length * .95)] ?? 0,
        max: samples.at(-1) ?? 0 }, peakRss, viewportTop: tui?.viewportTop, following: tui?.isFollowingOutput });
    frames.clear();
  };
  pi.on("session_start", (_event, context) => {
    ctx = context;
    context.ui.setWidget("history-measure", value => {
      tui = value;
      return { render: () => [], invalidate() {} };
    });
    setTimeout(() => measure("opened"), 1800);
  });
  pi.registerShortcut("alt+1", { description: "Measure opening and start scroll samples", handler: () => { measure("before-scroll"); stage = "scroll"; } });
  pi.registerShortcut("alt+2", { description: "Measure scrolling and start typing samples", handler: () => { measure("scroll"); stage = "typing"; tui.scrollToBottom(); } });
  pi.registerShortcut("alt+3", { description: "Measure typing and start backward loading", handler: () => { measure("typing"); stage = "load"; ctx.ui.setEditorText(""); } });
  pi.registerShortcut("alt+4", { description: "Request one real top-of-transcript backward load", handler: () => {
    tui.scrollToTop();
    setTimeout(() => measure("loading"), 60);
  } });
  pi.registerShortcut("alt+5", { description: "Return to the tail and measure residency after visiting history", handler: () => {
    tui.scrollToBottom();
    for (const ms of [500, 1000, 1500]) setTimeout(() => measure(ms === 1500 ? "loaded" : "tail-rss"), ms);
    setTimeout(() => { stage = "loaded-scroll"; }, 1520);
  } });
  pi.registerShortcut("alt+6", { description: "Measure scroll then type at the bottom with follow enabled", handler: () => {
    measure("loaded-scroll"); tui.scrollToBottom();
    setTimeout(() => { stage = "loaded-typing"; measure("typing-ready"); }, 150);
  } });
  pi.registerShortcut("alt+7", { description: "Finish history measurements", handler: () => measure("loaded-typing") });
}
