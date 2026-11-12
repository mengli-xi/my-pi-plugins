import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { integrationScenarios, selectScenarios } from "../integration/scenarios.mjs";
import { runCommand } from "./pi-upgrade-check.mjs";
import { repositoryRoot } from "./pi-checks.mjs";

test("integration 唯一清单覆盖默认和 Subagents 文件，定向入口只是过滤", () => {
  const suites = integrationScenarios();
  assert.equal(new Set(suites.map(s => s.id)).size, suites.length);
  assert.deepEqual(selectScenarios(suites, "default").map(s => s.id), readdirSync(join(repositoryRoot, "integration")).filter(f => f.endsWith(".test.ts")).sort());
  assert.deepEqual(selectScenarios(suites, "subagents").map(s => s.id), readdirSync(join(repositoryRoot, "integration/subagents/real")).filter(f => f.endsWith(".test.ts")).sort().map(f => `subagents/${f}`));
  for (const tag of ["mcp", "ask", "search"]) {
    const selected = selectScenarios(suites, tag);
    assert.ok(selected.every(s => s.tags.includes("default")));
    assert.ok(selected.every(s => suites.filter(other => other.id === s.id).length === 1));
  }
  assert.deepEqual(selectScenarios(suites, "all"), suites.filter(suite => suite.stock !== false));
  assert.equal(selectScenarios(suites, "patched-host")[0].stock, false);
  assert.throws(() => selectScenarios(suites, "typo"));
  assert.ok(suites.every(s => s.timeoutMs > 0));
  const scripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"))).scripts;
  for (const tag of ["mcp", "ask", "search", "subagents", "side-chat", "stock-host", "goal-ui", "patched-host"]) assert.equal(scripts[`test:integration:${tag}`], `node integration/run.mjs ${tag}`);
});

test("验收构建包装器复用本次构建，不改变正常 build", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-build-unit-"));
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "owner" }));
    writeFileSync(join(root, "bin/npm"), '#!/bin/sh\necho built\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` };
    const helper = fileURLToPath(new URL("./check-build.mjs", import.meta.url));
    const invoke = prebuilt => execFileSync(process.execPath, [helper], { cwd: root, env: { ...env, PI_CHECK_PREBUILT: JSON.stringify(prebuilt) }, encoding: "utf8" });
    assert.equal(invoke([]).trim(), "built");
    assert.equal(invoke(["other"]).trim(), "built");
    assert.equal(invoke(["owner"]), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("外层 perl alarm 中断仍回收命令并返回失败证据", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-alarm-unit-"));
  try {
    const runner = new URL("./pi-upgrade-check.mjs", import.meta.url).href;
    const code = `import {runCommand} from ${JSON.stringify(runner)}; setTimeout(()=>process.kill(process.pid,'SIGALRM'),500); console.log(JSON.stringify(await runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:process.env,log:${JSON.stringify(join(root, "alarm.log"))}})));`;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000 }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "收到 SIGALRM");
    assert.deepEqual(result.kinds, ["timeout"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("命令正常退出和超时均回收脱离进程组的残留宿主", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clean-unit-"));
  try {
    for (const timeout of [false, true]) {
      const marker = join(root, `child-${timeout}`);
      const code = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});p.unref();${timeout ? "setInterval(()=>{},1000)" : ""}`;
      const result = await runCommand(process.execPath, ["-e", code], { cwd: root, env: process.env, log: join(root, `run-${timeout}.log`), timeoutMs: 2000, cleanupPaths: timeout ? [] : [marker] });
      assert.equal(result.status, timeout ? "failed" : "passed", result.output);
      if (timeout) assert.ok(result.kinds.includes("timeout"));
      const probe = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
      assert.equal(probe.status, 1, `残留 PID: ${probe.stdout}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
