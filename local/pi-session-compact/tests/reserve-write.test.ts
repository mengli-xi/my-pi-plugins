import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { createEventBus, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import sessionCompact from "../index.ts";
import { reserveReport } from "../src/reserve.ts";
import { readReserveSettings, writeReserveSettings } from "../src/reserve-storage.ts";

const models = [
  { provider: "reserve-faux", id: "match", contextWindow: 200000 },
  { provider: "reserve-faux", id: "missing", contextWindow: 872000 },
  { provider: "reserve-faux", id: "wrong", contextWindow: 1000000 },
];
const initial = '{\r\n  "sentinel": [1,2],\r\n  "compaction": {\r\n    "enabled": false,\r\n    "reserveTokens": 111,\r\n    "keepRecentTokens": 4321,\r\n    "modelOverrides": {\r\n      "reserve-faux/match": {"reserveTokens":20000,"keepRecentTokens":456},\r\n      "reserve-faux/wrong": {"extra":"stay","keepRecentTokens":987,"reserveTokens":21600},\r\n      "unavailable/model": {"reserveTokens":777}\r\n    }\r\n  },\r\n  "after": true\r\n}\r\n';
const project = '{"compaction":{"modelOverrides":{"reserve-faux/wrong":{"reserveTokens":333}}}}\n';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "compact-reserve-write-"));
  const agent = join(root, "agent"), cwd = join(root, "cwd");
  await mkdir(agent); await mkdir(join(cwd, ".pi"), { recursive: true });
  const path = join(agent, "settings.json"), projectPath = join(cwd, ".pi/settings.json");
  await writeFile(path, initial); await writeFile(projectPath, project);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { agent, cwd, path, projectPath };
}

/** 只替代确认 UI；生产命令、report、storage 与 proper-lockfile 均真实执行。 */
function commandHarness(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, confirm: (title: string, message: string) => Promise<boolean>, hasUI = true) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agent;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
  const notices: string[] = [];
  const pi: Pick<ExtensionAPI, "on" | "registerTool" | "events" | "registerCommand" | "getSettings"> = {
    on: () => () => {}, registerTool() {}, events: createEventBus(),
    registerCommand(name, command) { if (name === "compaction") handler = command.handler; },
    getSettings: () => JSON.parse(initial),
  };
  sessionCompact(pi as ExtensionAPI);
  assert.ok(handler);
  const ctx = {
    cwd: f.cwd, hasUI, isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => models },
    ui: { confirm, notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  return { run: () => handler!("reserve write", ctx), notices };
}

function assertProposal(title: string, message: string, path: string) {
  assert.equal(title, "写入全局压缩阈值？");
  assert.ok(message.startsWith(path + "\n"));
  assert.ok(message.includes("reserve-faux/wrong: reserveTokens 21600 → 100000, keepRecentTokens=987"));
  assert.ok(message.includes("reserve-faux/missing: reserveTokens 缺覆盖 → 87200, keepRecentTokens=4321"));
  assert.ok(!message.includes("reserve-faux/match:"), "matching models must not be proposed for writing");
}

async function assertNoWrite(f: Awaited<ReturnType<typeof fixture>>, expected = initial) {
  assert.equal(await readFile(f.path, "utf8"), expected);
  assert.equal(await readFile(f.projectPath, "utf8"), project);
  assert.deepEqual(await readdir(f.agent), ["settings.json"], "no backup, lock or temporary file remains");
}

test("cancelling the actual reserve confirmation leaves settings and backups untouched", async t => {
  const f = await fixture(t);
  let asked!: () => void, answer!: (confirmed: boolean) => void;
  const entered = new Promise<void>(resolve => { asked = resolve; });
  const choice = new Promise<boolean>(resolve => { answer = resolve; });
  const h = commandHarness(t, f, async (title, message) => { assertProposal(title, message, f.path); asked(); return choice; });
  const pending = h.run();
  try { await entered; await assertNoWrite(f); } finally { answer(false); await pending; }
  await assertNoWrite(f);
  assert.ok(h.notices.some(message => message.includes("已取消，未写入")));
});

test("reserve write without a confirmation UI never writes", async t => {
  const f = await fixture(t);
  const h = commandHarness(t, f, async () => { assert.fail("no-UI must not ask for confirmation"); }, false);
  await h.run();
  await assertNoWrite(f);
  assert.ok(h.notices.some(message => message.includes("写入需要确认框")));
});

for (const conflict of ["global compaction", "project settings"] as const) {
  test(`a ${conflict} change during confirmation refuses the reserve write without a backup`, async t => {
    const f = await fixture(t);
    const changed = initial.replace('"reserveTokens": 111', '"reserveTokens": 222');
    const changedProject = project.replace('"reserveTokens":333', '"reserveTokens":444');
    const h = commandHarness(t, f, async (title, message) => {
      assertProposal(title, message, f.path);
      await writeFile(conflict === "global compaction" ? f.path : f.projectPath, conflict === "global compaction" ? changed : changedProject);
      return true;
    });
    await h.run();
    assert.ok(h.notices.some(message => message.includes("确认期间 compaction 或项目设置已变化，未写入")));
    assert.equal(await readFile(f.path, "utf8"), conflict === "global compaction" ? changed : initial);
    assert.equal(await readFile(f.projectPath, "utf8"), conflict === "project settings" ? changedProject : project);
    assert.deepEqual(await readdir(f.agent), ["settings.json"]);
  });
}

test("confirmed reserve write merges unrelated edits, retains model fields and backs up exact pre-write bytes", async t => {
  const f = await fixture(t), concurrent = initial.replace('"after": true', '"after": false');
  const h = commandHarness(t, f, async (title, message) => {
    assertProposal(title, message, f.path);
    await writeFile(f.path, concurrent);
    return true;
  });
  await h.run();
  const text = await readFile(f.path, "utf8"), result = JSON.parse(text);
  assert.equal(result.after, false);
  assert.ok(text.includes('"sentinel": [1,2]'));
  assert.ok(text.includes('"reserve-faux/match": {"reserveTokens":20000,"keepRecentTokens":456}'));
  assert.deepEqual(result.compaction.modelOverrides["reserve-faux/wrong"], { extra: "stay", keepRecentTokens: 987, reserveTokens: 100000 });
  assert.deepEqual(result.compaction.modelOverrides["reserve-faux/missing"], { reserveTokens: 87200, keepRecentTokens: 4321 });
  assert.deepEqual(result.compaction.modelOverrides["unavailable/model"], { reserveTokens: 777 });
  assert.deepEqual(Object.keys(result), Object.keys(JSON.parse(initial)));
  assert.equal(await readFile(f.projectPath, "utf8"), project);
  const backups = (await readdir(f.agent)).filter(name => name.startsWith("settings.json.before-reserve-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(join(f.agent, backups[0]!)), Buffer.from(concurrent), "backup must preserve CRLF and all original bytes");
  assert.deepEqual((await readdir(f.agent)).sort(), ["settings.json", backups[0]!].sort());
  assert.ok(h.notices.some(message => message.includes("已写入 2 项") && message.includes("正在运行的会话要重启")));
});

test("writeReserveSettings waits for Pi's file lock and rereads before backup and merge", async t => {
  const f = await fixture(t), snapshot = await readReserveSettings(f.agent, f.cwd);
  const approved = reserveReport(models, snapshot.global, snapshot.project);
  // Pi 1.5 FileSettingsStorage uses this exact path with realpath:false.
  const release = await lockfile.lock(f.path, { realpath: false });
  let settled = false;
  const pending = writeReserveSettings(f.agent, f.cwd, models, approved, snapshot).finally(() => { settled = true; });
  const concurrent = initial.replace('"after": true', '"after": false');
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(settled, false, "writer must remain pending while Pi owns the lock");
    assert.equal(await readFile(f.path, "utf8"), initial);
    assert.deepEqual((await readdir(f.agent)).sort(), ["settings.json", "settings.json.lock"]);
    await writeFile(f.path, concurrent);
  } finally { await release(); await pending; }
  const backup = await pending;
  assert.ok(backup);
  assert.deepEqual(await readFile(backup), Buffer.from(concurrent), "snapshot/backup must be taken after acquiring the lock");
  const result = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(result.after, false);
  assert.equal(result.compaction.modelOverrides["reserve-faux/wrong"].reserveTokens, 100000);
  assert.equal(await readFile(f.projectPath, "utf8"), project);
  assert.deepEqual((await readdir(f.agent)).sort(), ["settings.json", backup.slice(f.agent.length + 1)].sort());
});
