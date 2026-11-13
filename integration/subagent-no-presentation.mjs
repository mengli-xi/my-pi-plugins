import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import xterm from "@xterm/headless";

const cli = process.env.PI_PATCHED_CLI ?? resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const stock = !process.env.PI_PATCHED_CLI;

const root = mkdtempSync(join(tmpdir(), "subagent-no-cc-"));
const pkg = resolve("local/pi-subagents"), agent = join(root, "agent");
mkdirSync(join(agent, "pi-subagents"), { recursive: true, mode: 0o700 });
writeFileSync(join(agent, "pi-subagents/config.json"), JSON.stringify({ schemaVersion: 2 }));
mkdirSync(join(agent, "themes"), { recursive: true });
const palette = JSON.parse(readFileSync(resolve("local/pi-claude-style/themes/cc-style-soft.json"), "utf8"));
palette.name = "no-cc-theme";
writeFileSync(join(agent, "themes/no-cc-theme.json"), JSON.stringify(palette));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [], theme: "no-cc-theme", quietStartup: true, retry: { enabled: false }, cacheWarming: "off" }));
writeFileSync(join(root, "fixture.txt"), "NATIVE_CHILD_FIXTURE");
writeFileSync(join(root, "main.jsonl"), JSON.stringify({ type: "session", version: 3, id: "no-cc-main", timestamp: new Date().toISOString(), cwd: root }) + "\n");
const terminal = new xterm.Terminal({ cols: 112, rows: 38, allowProposedApi: true });
const child = Bun.spawn({ cmd: ["node", cli, "--offline", "--session", join(root, "main.jsonl"), "--tui-mode", "fullscreen", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
  "-e", join(pkg, "test/fixtures/test-commands.ts"), "-e", join(pkg, "test/fixtures/sdk-view-main.mjs"),
  "--provider", "fixture", "--model", "faux-view", "--thinking", "off", "--approve"],
  cwd: root, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SDK_VIEW_ROOT: root,
    PI_SUBAGENTS_TEST_MESSAGE: "TOOL_FIRST", PI_SUBAGENTS_TEST_TASK_NAME: "view_child", TERM: "xterm-256color" },
  stdin: "ignore", stderr: "pipe", terminal: { cols: 112, rows: 38, data(_pty, bytes) { terminal.write(bytes); } } });
const stderr = new Response(child.stderr).text();
const events = () => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const screen = () => Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
async function wait(label, predicate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}: ${await stderr}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`${label}\n${screen()}\n${events().slice(-5).map(JSON.stringify).join("\n")}`);
}
let serial = 0;
async function control(op, extra = {}) {
  const id = ++serial;
  appendFileSync(join(root, "commands.jsonl"), JSON.stringify({ id, op, ...extra }) + "\n");
  await wait(op, () => events().some(event => event.event === "control" && event.id === id));
  const reply = events().find(event => event.event === "control" && event.id === id);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}
try {
  await wait("Main ready", () => events().some(event => event.event === "main-ready"));
  // Force the Completion's Main continuation to lag behind child settlement.
  // A settled Task (or an idle Main before the wake starts) is not a drain barrier.
  await control("hold-main-run");
  child.terminal.write("/subagents-test-spawn\r");
  await wait("faux child settled", async () => (await control("snapshot")).agents?.[0]?.tasks[0]?.phase === "settled");
  await wait("Completion continuation held", () => events().some(event => event.event === "main-run-held"));
  assert.deepEqual(events().filter(event => event.event === "request").map(event => [event.role, event.lastRole]),
    [["child", "user"], ["child", "toolResult"]], "child tool/final requests precede the delayed Main continuation");
  await control("release-main-run");
  await wait("Completion processed and Main idle", async () => {
    const delivery = await control("delivery");
    return delivery.completions.length === 1 && delivery.outboxes.length === 1
      && delivery.outboxes.every(outbox => outbox.state === "delivered" && outbox.turnSettlement === "settled")
      && (await control("snapshot")).mainIdle;
  });
  const before = await control("snapshot");
  assert.equal(before.presentationProviders, undefined, "no CC presentation registry is installed");
  const timings = [];
  const requests = events().filter(event => event.event === "request");
  assert.deepEqual(requests.map(event => event.role), ["child", "child", "main"], "Completion continuation finishes before the view baseline");
  assert.ok(requests[2].text.includes("Automated background mailbox delivery"), "Main request is the Completion wake");
  const requestCount = requests.length;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await control("observe-view", { token: String(attempt) });
    child.terminal.write("/subagents /root/view_child\r");
    await wait("native child view opened", async () => (await control("snapshot")).childMode === "tui" && screen().includes("VIEW_REPLY"));
    assert.ok(screen().includes("VIEW_REPLY"), "the native view displays the faux child's history");
    await wait("view ready", () => events().some(event => event.event === "view-boundary" && event.token === String(attempt) && event.kind === "ready"));
    const boundaries = events().filter(event => event.event === "view-boundary" && event.token === String(attempt));
    const openedMs = boundaries.find(event => event.kind === "ready").monotonicAt - boundaries.find(event => event.kind === "init-start").monotonicAt;
    assert.ok(!boundaries.some(event => event.kind === "deadline"), "no initialization deadline fallback");
    assert.ok(openedMs < 2000, `handoff ${openedMs} ms exceeds deadline`);
    await control("observe-return", { token: String(attempt) });
    const returnStarted = performance.now();
    child.terminal.write("\x1b/");
    await wait("Main restored", async () => (await control("snapshot")).childMode === "print");
    const returnedMs = performance.now() - returnStarted;
    const restoration = events().find(event => event.event === "main-restored" && event.token === String(attempt));
    assert.ok(returnedMs < 2000, `return ${returnedMs} ms exceeds deadline`);
    timings.push({ openedMs: Math.round(openedMs), returnedMs: Math.round(returnedMs), restoreMs: restoration.completedAt - restoration.startedAt });
    const after = await control("snapshot");
    assert.equal(after.editorSame, true);
    assert.equal(after.presentationProviders, undefined);
    assert.equal(after.agents[0].tasks.length, before.agents[0].tasks.length, "opening a view starts no model task");
    assert.equal(after.theme.name, "no-cc-theme");
    assert.equal(after.theme.accent, before.theme.accent, "entry palette preserved");
    assert.equal(events().filter(event => event.event === "request").length, requestCount, "view entry/return sends no requests");
  }
  assert.equal(events().filter(event => event.event === "stock-theme-notice").length, stock ? 1 : 0, "only stock hosts show one theme degradation notice");
  child.terminal.write("/quit\r");
  await wait("host quit", () => child.exitCode !== null);
  assert.equal(await child.exited, 0, await stderr);
  console.log(`PASS: ${stock ? "stock" : "patched"} Pi, no CC, faux provider only; handoffs=${JSON.stringify(timings)}`);
} catch (error) {
  const timeline = events().filter(event => event.event !== "control").map(({ messages, ...event }) => event);
  console.error("REQUEST TIMELINE", JSON.stringify(timeline));
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  child.terminal?.close();
  terminal.dispose();
  rmSync(root, { recursive: true, force: true });
}
