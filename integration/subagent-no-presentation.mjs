import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import xterm from "@xterm/headless";

const root = mkdtempSync(join(tmpdir(), "subagent-no-cc-"));
const pkg = resolve("local/pi-subagents"), agent = join(root, "agent");
mkdirSync(join(agent, "pi-subagents"), { recursive: true, mode: 0o700 });
writeFileSync(join(agent, "pi-subagents/config.json"), JSON.stringify({ schemaVersion: 2 }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [], theme: "dark", quietStartup: true, retry: { enabled: false }, cacheWarming: "off" }));
writeFileSync(join(root, "fixture.txt"), "NATIVE_CHILD_FIXTURE");
writeFileSync(join(root, "main.jsonl"), JSON.stringify({ type: "session", version: 3, id: "no-cc-main", timestamp: new Date().toISOString(), cwd: root }) + "\n");
const terminal = new xterm.Terminal({ cols: 112, rows: 38, allowProposedApi: true });
const child = Bun.spawn({ cmd: ["node", process.env.PI_PATCHED_CLI, "--offline", "--session", join(root, "main.jsonl"), "--tui-mode", "fullscreen", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
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
async function control(op) {
  const id = ++serial;
  appendFileSync(join(root, "commands.jsonl"), JSON.stringify({ id, op }) + "\n");
  await wait(op, () => events().some(event => event.event === "control" && event.id === id));
  const reply = events().find(event => event.event === "control" && event.id === id);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}
try {
  await wait("Main ready", () => events().some(event => event.event === "main-ready"));
  child.terminal.write("/subagents-test-spawn\r");
  await wait("faux child settled", async () => (await control("snapshot")).agents?.[0]?.tasks[0]?.phase === "settled");
  const before = await control("snapshot");
  assert.equal(before.presentationProviders, undefined, "no CC presentation registry is installed");
  child.terminal.write("/subagents /root/view_child\r");
  await wait("native child view opened", async () => (await control("snapshot")).childMode === "tui" && screen().includes("VIEW_REPLY"));
  assert.ok(screen().includes("VIEW_REPLY"), "the native view displays the faux child's history");
  child.terminal.write("\x1b/");
  await wait("Main restored", async () => (await control("snapshot")).childMode === "print");
  const after = await control("snapshot");
  assert.equal(after.editorSame, true);
  assert.equal(after.presentationProviders, undefined);
  assert.equal(after.agents[0].tasks.length, before.agents[0].tasks.length, "opening a view starts no model task");
  child.terminal.write("/quit\r");
  await wait("host quit", () => child.exitCode !== null);
  assert.equal(await child.exited, 0, await stderr);
  console.log("PASS: Subagents opens native child view and returns without pi-claude-style; faux provider only");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  terminal.dispose();
  rmSync(root, { recursive: true, force: true });
}
