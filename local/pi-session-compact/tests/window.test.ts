import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager, createEventBus, findCutPoint, type CompactionEntry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { COMPACTION_SUBCOMMANDS, WINDOW_ENTRY, WINDOW_SCAFFOLDS, compactionCompletions, holdsCompaction, keepRecentFor, minimumWindow, parseWindow, sessionWindow, windowAction, windowThreshold } from "../src/window.ts";
import { describeCompaction } from "../src/show.ts";
import sessionCompact from "../index.ts";

const root = mkdtempSync(join(tmpdir(), "compact-window-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent/pi-session-compact"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

test("window sizes parse k/m/plain tokens and off; anything else is rejected", () => {
  assert.equal(parseWindow("262k"), 262000);
  assert.equal(parseWindow(" 262144 "), 262144);
  assert.equal(parseWindow("1m"), 1000000);
  assert.equal(parseWindow("1.5M"), 1500000);
  assert.equal(parseWindow("OFF"), "off");
  for (const bad of ["", "0", "-1", "262kb", "1e6", "k", "262 k"]) assert.equal(parseWindow(bad), undefined, bad);
  for (const scaffold of WINDOW_SCAFFOLDS) assert.notEqual(parseWindow(scaffold), undefined, `${scaffold} is real input`);
});

test("completions come from the parser's subcommands and real window scaffolds", () => {
  assert.deepEqual(compactionCompletions("")?.map((i) => i.label), [...COMPACTION_SUBCOMMANDS]);
  assert.deepEqual(compactionCompletions("w")?.map((i) => i.value), ["window "]);
  assert.deepEqual(compactionCompletions("sh")?.map((i) => i.value), ["show"]);
  assert.deepEqual(compactionCompletions("window ")?.map((i) => i.value), WINDOW_SCAFFOLDS.map((s) => `window ${s}`));
  assert.deepEqual(compactionCompletions("window o")?.map((i) => i.value), ["window off"]);
  assert.deepEqual(compactionCompletions("window 2")?.map((i) => i.value), ["window 262k"]);
  for (const unknown of ["x", "window 9", "show x", "windowx"]) assert.equal(compactionCompletions(unknown), null, unknown);
});

test("over 90% compacts; a window attempt that stays above only warns once until usage falls back", () => {
  assert.equal(windowThreshold(20000), 18000);
  assert.equal(windowAction(null, 20000, null, undefined), "unknown");
  assert.equal(windowAction(18000, 20000, null, undefined), "below");
  assert.equal(windowAction(18001, 20000, "c1", undefined), "compact");
  assert.equal(windowAction(18001, 20000, "c2", { compactionId: "c2", warned: false }), "warn");
  assert.equal(windowAction(18001, 20000, "c2", { compactionId: "c2", warned: true }), "suppressed");
  assert.equal(windowAction(18001, 20000, "c3", { compactionId: "c2", warned: true }), "compact", "another compaction re-arms");
});

test("the effective window must still hold a compaction under its own trigger", () => {
  assert.equal(keepRecentFor(262000), 20000);
  assert.equal(keepRecentFor(50000), 10000);
  const minimum = minimumWindow(6000, 8192);
  assert.ok(holdsCompaction(minimum, 6000, 8192) && !holdsCompaction(minimum - 1, 6000, 8192));
  const large = minimumWindow(70000, 8192);
  assert.ok(large > 100000 && holdsCompaction(large, 70000, 8192) && !holdsCompaction(large - 1, 70000, 8192));
  assert.ok(large < (70000 + 8192 + 1024) / 0.7, "above 100k the kept tail is capped at 20k");
});

test("the latest window entry on the branch wins and off clears it", () => {
  const custom = (id: string, tokens: number | null) => ({ type: "custom", id, parentId: null, timestamp: "t", customType: WINDOW_ENTRY, data: { version: 1, tokens } });
  assert.equal(sessionWindow([custom("a", 262000)] as never), 262000);
  assert.equal(sessionWindow([custom("a", 262000), custom("b", null)] as never), undefined);
  assert.equal(sessionWindow([custom("a", null), custom("b", 300000)] as never), 300000);
});

test("show reads sizes, skill restoration and shadow while tolerating legacy diagnostics", () => {
  const entry = { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-10-17T00:00:00.000Z", summary: "SUMMARY_BODY", firstKeptEntryId: "u9", tokensBefore: 100,
    details: { operationId: "op", restoreSkills: [{ name: "fix", path: "/s/SKILL.md" }], knownUncertainties: [] } } as CompactionEntry;
  const run = { triggerReason: "session-window", threshold: { contextWindow: 600000, effectiveWindow: 262000 }, shadow: { enabled: true, adopt: "main" }, adopted: { slot: "main", effectiveMode: "main" },
    outputs: { main: { status: "generated", effectiveMode: "main", attempts: [{ elapsedMs: 2500 }], validated: { summary: "x".repeat(300), uncertainties: [{ statement: "IMAGE_GAP", neededRecovery: "reopen" }], droppedCitations: [{}, {}] } },
      small: { status: "cancelled", attempts: [{ elapsedMs: 1000 }] } },
    contextSizes: { before: { estimated: { total: 240000 } }, requests: [{ slot: "main", estimated: { total: 230000 } }, { slot: "small", estimated: { total: 9 } }], after: { estimated: { total: 30000, summary: 5000, retainedRecent: 20000, recoveryPackage: 300 }, providerReported: { rawUsage: { input: 31000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 31010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } } };
  const restored = { type: "custom_message", id: "r", parentId: "c1", timestamp: "t", customType: "pi-skills:compact-restored-v1", content: "", display: false, details: { operationId: "op" } };
  const text = describeCompaction(entry, [entry, restored] as never, run);
  for (const expected of ["采用：main", "session-window（本会话有效窗口）；有效窗口 262,000，模型窗口 600,000", "压缩前 240,000；材料 230,000（1 个请求）；压缩后 30,000", "provider 实报：31,010", "保留尾部：20,000 tokens，从 entry u9", "fix（/s/SKILL.md）；已确认恢复", "small 为影子；main 完成", "small 取消", "SUMMARY_BODY", "The conversation history before this point was compacted"])
    assert.ok(text.includes(expected), expected);
  const native = describeCompaction({ ...entry, details: { knownUncertainties: [{ statement: "KNOWN_ONLY" }] } } as CompactionEntry, [entry] as never, undefined);
  assert.match(native, /不是 pi-session-compact 生成的/);
  assert.doesNotMatch(native, /KNOWN_ONLY|不确定项|丢弃的引用/);
});

// The real extension handlers over an in-memory session; the summarizer answers immediately.
function harness() {
  writeFileSync(join(root, "agent/pi-session-compact/config.json"), JSON.stringify({ mode: "small", smallModel: { provider: "fake", id: "small", effort: "off" }, outputTokens: 2048, summaryTokens: 8000 }));
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const reply = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "toolCall", id: "submit", name: "submit_compaction", arguments: text as any }], api: "fake", provider: "fake", model: "small", usage, stopReason: "toolUse", timestamp: Date.now() });
  const sm = SessionManager.inMemory(root);
  for (let i = 0; i < 6; i++) { sm.appendMessage({ role: "user", content: `USER_${i} ${"word ".repeat(500)}`, timestamp: 2 * i + 1 }); sm.appendMessage(reply("ok")); }
  const notices: string[] = [], compacts: Array<{ onComplete?: () => void; onError?: (e: Error) => void }> = [], commands = new Map<string, any>();
  let used: number | null = null;
  const model = { provider: "fake", id: "small", api: "fake", name: "small", contextWindow: 200000, maxTokens: 32000, reasoning: false, input: ["text"], cost: usage.cost, baseUrl: "" };
  const ctx: any = {
    model, mode: "rpc", hasUI: false, cwd: root, thinkingLevel: "off", sessionManager: sm, abort() {}, getSystemPrompt: () => "SYSTEM",
    getContextUsage: () => ({ tokens: used, contextWindow: 200000, percent: null }), compact: (options: any) => compacts.push(options),
    ui: { notify: (text: string) => notices.push(text), theme: { fg: (_tone: string, text: string) => text } },
    modelRegistry: { find: () => model, streamSimple(_m: unknown, context: { messages: Array<{ content: unknown }> }) {
      const request = String(context.messages.at(-1)!.content), stream = createAssistantMessageEventStream();
      const ids = (request.split("Required user/QA sources: ")[1]?.split("\n")[0] ?? "").replace(/\.$/, "").split(", ").filter((id) => /^[UQ]\d+$/.test(id));
      const message = reply(JSON.stringify({ version: 1, goal: { text: "Keep restrictions.", sourceEntryIds: [], phase: "active" }, progress: [], inFlight: [], openQuestions: [], nextActions: [], references: [], userMessages: { mode: request.includes("User-message mode: key_points") ? "key_points" : "verbatim", items: ids.map((id) => ({ kind: "user", sourceRefs: [id], text: "point" })) }, uncertainties: [], memoryCandidates: [], restoreSkills: [] }));
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); });
      return stream;
    } },
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => any>();
  const events = createEventBus(), rows: Array<{ key: string; line?: string; placement?: string; row?: number; align?: string; onClick?: () => boolean }> = [];
  events.on("statusline:row", (payload) => rows.push(payload as (typeof rows)[number]));
  const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerCommand: (name: string, options: unknown) => commands.set(name, options), events, getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({ retry: { enabled: false }, compaction: { reserveTokens: 1000 } }), sendMessage() {}, appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data) };
  sessionCompact(pi);
  const emit = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
  const command = (args: string) => commands.get("compaction").handler(args, ctx);
  const beforeCompact = (keepRecentTokens: number, options: { reserveTokens?: number; reason?: "manual" | "threshold" | "overflow" } = {}) => {
    const branch = sm.getBranch();
    const preparation = { firstKeptEntryId: branch.at(-1)!.id, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, settings: { enabled: true, reserveTokens: options.reserveTokens ?? 1000, keepRecentTokens } };
    return emit("session_before_compact", { preparation, branchEntries: branch, reason: options.reason ?? "manual", willRetry: false, signal: new AbortController().signal }) as Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: { operationId: string; runLog: string } } }>;
  };
  return { sm, ctx, notices, compacts, command, emit, beforeCompact, rows, setUsage: (value: number | null) => { used = value; } };
}

test("window command validates against the real window and the compaction floor, then persists a custom entry", async () => {
  const h = harness();
  await h.command("window 300k");
  assert.match(h.notices.at(-1)!, /大于 fake\/small 的真实窗口 200,000/);
  await h.command("window 1k");
  assert.match(h.notices.at(-1)!, /装不下压缩本身.*至少需要/);
  await h.command("window abc");
  assert.match(h.notices.at(-1)!, /无法识别/);
  assert.equal(sessionWindow(h.sm.getBranch()), undefined);
  await h.command("window 20k");
  assert.equal(sessionWindow(h.sm.getBranch()), 20000);
  assert.match(h.notices.at(-1)!, /超过 18,000（90%）自动压缩/);
  await h.command("window off");
  assert.equal(sessionWindow(h.sm.getBranch()), undefined);
  await h.command("bogus");
  assert.match(h.notices.at(-1)!, /用法/);
});

test("native diagnostics use the supplied reserve and accept either 90% integer boundary without hiding mismatches", async () => {
  for (const reserve of [16384, 50000, 50001]) {
    const h = harness();
    h.ctx.model.contextWindow = 500000;
    const { compaction } = await h.beforeCompact(1, { reserveTokens: reserve, reason: "threshold" });
    const run = JSON.parse(readFileSync(join(root, "agent", compaction.details.runLog), "utf8"));
    assert.equal(run.threshold.ratio, (500000 - reserve) / 500000);
    assert.equal(run.threshold.boundaryTokens, 500000 - reserve);
    assert.equal(run.threshold.triggerTokens, 500001 - reserve);
    assert.deepEqual([run.threshold.source, run.threshold.eventReason, run.threshold.comparison, run.threshold.windowSource], ["threshold", "threshold", ">", "selected-model"]);
    assert.equal(h.notices.some((n) => n.includes("不是 90%")), reserve === 16384);
    const shown = describeCompaction({ type: "compaction", id: "c", parentId: null, timestamp: new Date().toISOString(), ...compaction } as CompactionEntry, [], run);
    assert.ok(shown.includes(`reserveTokens=${reserve.toLocaleString("en-US")}`));
    if (reserve === 16384) assert.match(shown, /tokens > 483,616（最早 483,617，边界 96\.7232%/);
  }
  const invalid = harness();
  invalid.ctx.model.contextWindow = 0;
  await invalid.beforeCompact(1);
  assert.ok(invalid.notices.some((n) => n.includes("无法核验原生压缩阈值")), "an invalid window must be diagnosed, not silently exempted");
  for (const reason of ["manual", "overflow"] as const) {
    const h = harness();
    const { compaction } = await h.beforeCompact(1, { reason });
    const run = JSON.parse(readFileSync(join(root, "agent", compaction.details.runLog), "utf8"));
    assert.equal(run.threshold.eventReason, reason);
    assert.equal(run.threshold.ratio, undefined, "manual/overflow are not attributed to a percentage threshold");
    assert.equal(run.threshold.source, undefined);
    assert.ok(run.threshold.native, "the reserve relationship remains available for inspection");
  }
});

test("a session window triggers at a settled boundary, records its reason and drives budgets and the kept tail", async () => {
  const h = harness();
  const plain = await h.beforeCompact(1);
  assert.equal(JSON.parse(readFileSync(join(root, "agent", plain.compaction.details.runLog), "utf8")).userMessages.version, 1);
  await h.command("window 14k");
  h.setUsage(13000);
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.compacts.length, 0, "an aborted run is not a boundary");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.compacts.length, 1);
  const notices = h.notices.length;
  const { compaction } = await h.beforeCompact(1);
  const run = JSON.parse(readFileSync(join(root, "agent", compaction.details.runLog), "utf8"));
  assert.equal(run.triggerReason, "session-window");
  assert.deepEqual([run.threshold.contextWindow, run.threshold.effectiveWindow, run.threshold.keepRecentTokens], [200000, 14000, 2800]);
  assert.deepEqual([run.threshold.ratio, run.threshold.triggerTokens, run.threshold.source, run.threshold.eventReason], [0.9, 12601, "session-window", "manual"]);
  assert.equal(run.threshold.native.triggerTokens, 199001, "native reserve uses the model window, not the session budget");
  assert.ok(run.userMessages.tokens > 0);
  assert.equal(run.userMessages.summaryBudget, undefined);
  assert.ok(h.notices.slice(notices).every((n) => !n.includes("reserveTokens")), "no 90% mismatch warning under a session window");
  const branch = h.sm.getBranch();
  assert.equal(compaction.firstKeptEntryId, branch[findCutPoint(branch, 0, branch.length, 2800).firstKeptEntryIndex]!.id);
  assert.notEqual(compaction.firstKeptEntryId, branch.at(-1)!.id);
  h.sm.appendCompaction(compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore, compaction.details, true);
  h.compacts[0]!.onComplete!();
  await h.emit("agent_settled", { aborted: false });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.compacts.length, 1, "still above right after the window compaction: no loop");
  assert.equal(h.notices.filter((n) => n.includes("刚压缩过")).length, 1, "warned exactly once");
  h.setUsage(5000);
  await h.emit("agent_settled", { aborted: false });
  h.setUsage(13000);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.compacts.length, 2, "falling back below the threshold re-arms the trigger");
  await h.command("show");
  const shown = h.notices.at(-1)!;
  assert.ok(shown.includes("触发：session-window") && shown.includes("有效窗口 14,000") && shown.includes(compaction.summary.slice(0, 40)), shown);
});

test("the statusline segment follows the branch at boundaries, after a commit and on window or model changes, never mid-compaction, and withdraws at shutdown", async () => {
  const h = harness();
  const latest = () => h.rows.at(-1)!;
  const settled = async (count: number) => { for (const start = Date.now(); h.notices.length <= count; await new Promise((r) => setTimeout(r, 5))) if (Date.now() - start > 5000) throw new Error("timeout"); };
  const first = h.sm.getBranch()[0]!.id;
  await h.emit("session_start", { reason: "startup" });
  assert.deepEqual([latest().key, latest().line, latest().placement, latest().row, latest().align], ["compaction", undefined, "inline", 2, "left"], "nothing to show yet");
  await h.command("window 20k");
  assert.equal(latest().line, "CT:18k");
  const model = h.ctx.model;
  h.ctx.model = { ...model, contextWindow: 15000 };
  await h.emit("model_select", { model: h.ctx.model });
  assert.equal(latest().line, "CT:14k", "the effective window follows the model");
  h.ctx.model = model;
  await h.emit("model_select", { model });
  const before = h.rows.length;
  const { compaction } = await h.beforeCompact(1);
  assert.equal(h.rows.length, before, "a running compaction leaves the statusline alone");
  h.sm.appendCompaction(compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore, compaction.details, true);
  await h.emit("session_compact", { compactionEntry: h.sm.getBranch().at(-1), fromExtension: true });
  assert.equal(latest().line, "CP:1·CT:18k");
  // A click opens exactly what /compaction show opens.
  const notices = h.notices.length;
  assert.equal(latest().onClick!(), true);
  await settled(notices);
  const clicked = h.notices.at(-1)!;
  await h.command("show");
  assert.equal(h.notices.at(-1), clicked);
  assert.match(clicked, /模型看到的摘要/);
  h.sm.branch(first);
  await h.emit("session_tree", { newLeafId: first, oldLeafId: null });
  assert.equal(latest().line, undefined, "the earlier branch has neither a compaction nor a window");
  const click = h.rows.findLast((r) => r.onClick)!.onClick!;
  await h.emit("session_shutdown", { reason: "new" });
  assert.deepEqual([latest().key, latest().line], ["compaction", undefined]);
  assert.equal(click(), false, "a click left from the replaced session does nothing");
});

test("now passes only focus through public compact and consumes its override exactly once", async () => {
  const h = harness();
  const configPath = join(root, "agent/pi-session-compact/config.json"), original = readFileSync(configPath, "utf8");
  await h.command("now main 本次重点\n保留约束");
  assert.equal(h.compacts.length, 1);
  assert.equal((h.compacts[0] as any).customInstructions, "本次重点\n保留约束");
  const read = async () => {
    const result = await h.beforeCompact(1);
    return JSON.parse(readFileSync(join(root, "agent", result.compaction.details.runLog), "utf8"));
  };
  h.sm.appendMessage({ role: "user", content: "append while public compact aborts streaming", timestamp: Date.now() });
  const manual = await read();
  assert.deepEqual([manual.modeSelection.requestedMode, manual.adopted.slot], ["main", "main"]);
  assert.equal(manual.modeSelection.reason, "手动指定 main");
  assert.equal((await read()).adopted.slot, "small", "native /compact uses config after override was consumed");
  h.compacts[0]!.onComplete!();
  await h.command("now");
  assert.equal((await read()).modeSelection.requestedMode, "small", "omitted mode follows config");
  h.compacts[1]!.onComplete!();
  await h.command("now main");
  h.compacts[2]!.onError!(new Error("host rejected before hook"));
  assert.equal((await read()).adopted.slot, "small", "host errors cannot leak the override");
  await h.command("now main");
  await h.emit("session_shutdown", { reason: "new" });
  assert.equal((await read()).adopted.slot, "small", "session boundaries clear the override");
  assert.equal(readFileSync(configPath, "utf8"), original);
});
