import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkEnvironment, discoverChecks, installedPiVersion } from "./pi-checks.mjs";
import { diagnostics, main, parseArgs, renderReport, runCommand, updatePiVersions } from "./pi-upgrade-check.mjs";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-upgrade-unit-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};
const json = (path, value) => writeFileSync(path, JSON.stringify(value));

test("参数只接受精确版本、keep 与 apply", () => {
  assert.deepEqual(parseArgs(["1.6.0", "--keep", "--apply"]), { version: "1.6.0", keep: true, apply: true });
  assert.equal(parseArgs(["--keep", "2.0.0-rc.1"]).version, "2.0.0-rc.1");
  for (const args of [[], ["latest"], ["^1.6.0"], ["01.6.0"], ["1.6.0", "2.0.0"], ["1.6.0", "--help"], ["1.6.0", "--keep", "--keep"]]) assert.throws(() => parseArgs(args));
});

test("按 workspace 与约定发现新包，不包含旧名字或补丁宿主", () => {
  const f = fixture();
  try {
    json(join(f.root, "package.json"), { workspaces: ["local/*", "fork/*"] });
    mkdirSync(join(f.root, "local/new-package"), { recursive: true });
    mkdirSync(join(f.root, "fork/another"), { recursive: true });
    json(join(f.root, "local/new-package/package.json"), { name: "new", scripts: { "check:host": "anything", "check:internals": "anything", "test:patched-host": "excluded" } });
    json(join(f.root, "fork/another/package.json"), { name: "forked", scripts: { "check:host": "anything", "check-internals": "excluded" } });
    assert.deepEqual(discoverChecks(f.root), [
      { package: "forked", directory: "fork/another", check: "check:host" },
      { package: "new", directory: "local/new-package", check: "check:internals" },
      { package: "new", directory: "local/new-package", check: "check:host" },
    ]);
  } finally { f.cleanup(); }
});

test("仅改 Pi devDeps 或 peers，不触碰业务依赖；保留 peer 范围风格", () => {
  const source = { devDependencies: { "@earendil-works/pi-ai": "1.5.0", typescript: "~5.9.3" }, dependencies: { other: "1" }, peerDependencies: { "@earendil-works/pi-tui": "^1.5.0", "@earendil-works/pi-ai": "~1.5.0", other: "*" } };
  const { manifest: updated, manual } = updatePiVersions(source, "1.6.0");
  assert.equal(updated.devDependencies["@earendil-works/pi-ai"], "1.6.0");
  assert.equal(source.devDependencies["@earendil-works/pi-ai"], "1.5.0");
  assert.deepEqual(updated.peerDependencies, source.peerDependencies);
  assert.deepEqual(updated.dependencies, source.dependencies);
  assert.deepEqual(manual, []);
  const peers = updatePiVersions(source, "1.6.0", { peers: true });
  assert.equal(peers.manifest.peerDependencies["@earendil-works/pi-tui"], "^1.6.0");
  assert.equal(peers.manifest.peerDependencies["@earendil-works/pi-ai"], "~1.6.0");
  assert.equal(peers.manifest.peerDependencies.other, "*");
});

test("星号与并集范围的 peer 保持原样并报告人工处理", () => {
  const source = { peerDependencies: {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "^0.84.1 || ^0.85.0 || ^1.0.0",
    "@earendil-works/pi-coding-agent": ">=1.5.0 <2",
    "@earendil-works/pi-agent-core": "^1.5.0",
  } };
  const { manifest, manual } = updatePiVersions(source, "1.6.0", { peers: true });
  assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "^0.84.1 || ^0.85.0 || ^1.0.0");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=1.5.0 <2");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-agent-core"], "^1.6.0");
  assert.deepEqual(manual.map(item => [item.name, item.range]), [
    ["@earendil-works/pi-ai", "*"],
    ["@earendil-works/pi-tui", "^0.84.1 || ^0.85.0 || ^1.0.0"],
    ["@earendil-works/pi-coding-agent", ">=1.5.0 <2"],
  ]);
  assert.equal(source.peerDependencies["@earendil-works/pi-agent-core"], "^1.5.0");
});

test("报告区分包、步骤和失败项，并列出原始日志与验证边界", () => {
  const failures = diagnostics("> pi-example@0.1.0 test\n  not ok 3 - host seam\nnpm error workspace pi-example@0.1.0\nfork/new/index.ts(1,1): error TS2322: wrong type\n");
  assert.equal(failures[0].package, "pi-example");
  assert.equal(failures.at(-1).package, "new");
  assert.deepEqual(diagnostics("> pi-example@0.1.0 test\n✖ failed seam (20.3ms)\n✖ failing tests:\n✖ failed seam (20.3ms)\n FAIL  cold-loading.test.ts > loads production\n"), [
    { package: "pi-example", item: "✖ failed seam" },
    { package: "pi-example", item: "FAIL  cold-loading.test.ts > loads production" },
  ]);
  const text = renderReport({ from: ["1.5.0"], target: "1.6.0", directory: "/tmp/check", notices: ["真实 provider 未覆盖"], steps: [
    { package: "pi-example", stage: "私有 seam", item: "check:host", status: "failed", log: "/tmp/check/host.log", failures },
    { package: "new", stage: "私有 seam", item: "check:internals", status: "passed" },
    { package: "仓库", stage: "应用", item: "--apply", status: "skipped", reason: "有失败" },
  ] });
  for (const fragment of ["失败 · pi-example · 私有 seam · check:host", "host seam", "host.log", "通过 · new", "未运行 · 仓库", "有失败", "真实 provider", "report.json"]) assert.ok(text.includes(fragment), fragment);
});

test("隔离环境不继承用户 profile、provider 凭据或 Pi 目录覆盖", () => {
  const env = checkEnvironment("/tmp/check", { PI_BIN: "/tmp/pi" });
  assert.equal(env.HOME, "/tmp/check/home");
  assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/check/agent");
  assert.equal(env.PI_BIN, "/tmp/pi");
  for (const key of ["OPENAI_API_KEY", "PI_PACKAGE_DIR", "NODE_OPTIONS", "PI_PATCHED_SDK"]) assert.equal(env[key], undefined);
});

test("命令失败仍能执行下一项；日志包含原始 stdout 与 stderr，超时会失败", async () => {
  const f = fixture();
  try {
    const log = join(f.root, "failed.log");
    const failed = await runCommand(process.execPath, ["-e", 'console.log("out");console.error("raw error");process.exitCode=7'], { cwd: f.root, env: process.env, log });
    assert.equal(failed.status, "failed"); assert.equal(failed.code, 7);
    assert.match(readFileSync(log, "utf8"), /raw error/);
    const passed = await runCommand(process.execPath, ["-e", 'console.log("next")'], { cwd: f.root, env: process.env, log: join(f.root, "next.log") });
    assert.equal(passed.status, "passed");
    const timed = await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.root, env: process.env, log: join(f.root, "timeout.log"), timeoutMs: 300 });
    assert.equal(timed.status, "failed"); assert.match(timed.reason, /时限/);
  } finally { f.cleanup(); }
});

test("包级 host runner 在失败后继续，并统一传入 binary 与隔离环境", () => {
  const f = fixture();
  try {
    const binary = join(f.root, "pi");
    writeFileSync(binary, `#!/bin/sh\necho ${installedPiVersion()}\n`, { mode: 0o755 });
    // 第二个子命令把环境打到 stdout：不依赖写入临时文件，TMPDIR/HOME 隔离变化不会造成假失败。
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-host.mjs", import.meta.url)),
      process.execPath, "-e", "process.exit(3)", "::", process.execPath, "-e",
      'console.log("CHECK_HOST_ENV=" + JSON.stringify(process.env))',
    ], { env: { ...process.env, PI_BIN: binary, OPENAI_API_KEY: "must-not-leak", PI_PACKAGE_DIR: "/private/profile" }, encoding: "utf8" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const lines = result.stdout.split("\n");
    assert.ok(lines.some(line => line.includes("[check:host]")), result.stdout);
    assert.equal(lines.filter(line => line.includes("[check:host]")).length, 2, `失败后没有继续执行第二项\n${result.stdout}`);
    const env = JSON.parse(lines.find(line => line.startsWith("CHECK_HOST_ENV=")).slice("CHECK_HOST_ENV=".length));
    assert.equal(env.PI_BIN, binary);
    assert.notEqual(env.HOME, process.env.HOME);
    assert.equal(env.PI_PACKAGE_DIR, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.match(result.stderr, /失败：/);
  } finally { f.cleanup(); }
});

// 使用真实 CLI 路径和普通 PATH 命令替身，不为生产脚本加入离线测试开关。
test("版本不存在时在安装前失败、写报告且不改源仓库", async () => {
  const f = fixture();
  const previous = process.cwd(), path = process.env.PATH;
  let reportDirectory;
  try {
    execFileSync("git", ["init", "-q", f.root]);
    json(join(f.root, "package.json"), { devDependencies: { "@earendil-works/pi-ai": "1.5.0" }, workspaces: ["local/*"] });
    mkdirSync(join(f.root, "local/only"), { recursive: true });
    json(join(f.root, "local/only/package.json"), { name: "only", scripts: { test: "unit", "check:internals": "probe" } });
    execFileSync("git", ["-C", f.root, "add", "."]);
    execFileSync("git", ["-C", f.root, "-c", "user.name=测试", "-c", "user.email=test@example.invalid", "commit", "-qm", "测试夹具"]);
    mkdirSync(join(f.root, "bin"));
    writeFileSync(join(f.root, "bin/npm"), '#!/bin/sh\nprintf "version not found\\n" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(f.root, "bin/bun"), '#!/bin/sh\necho installed > "$HOME/UNEXPECTED_INSTALL"\nexit 99\n', { mode: 0o755 });
    // 替身放在忽略目录，保持被检仓库干净。
    execFileSync("git", ["-C", f.root, "config", "status.showUntrackedFiles", "no"]);
    process.env.PATH = `${join(f.root, "bin")}:${path}`;
    process.chdir(f.root);
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(" "));
    let result;
    try { result = await main(["9.99.0"]); }
    finally { console.log = originalLog; }
    assert.equal(result, 1);
    reportDirectory = lines.join("\n").match(/报告：(.*)\/report.json/)[1];
    const report = JSON.parse(readFileSync(join(reportDirectory, "report.json")));
    assert.equal(report.steps[0].status, "failed");
    assert.equal(report.steps[1].stage, "临时副本"); assert.equal(report.steps[1].status, "skipped");
    assert.equal(report.steps[2].stage, "安装"); assert.equal(report.steps[2].status, "skipped");
    assert.ok(report.steps.slice(1).every(step => step.status === "skipped"), JSON.stringify(report.steps));
    for (const stage of ["公开 API 签名", "公开 API 行为", "私有 seam"]) {
      assert.ok(report.steps.some(step => step.stage === stage && step.status === "skipped"), stage);
    }
    assert.equal(readFileSync(join(f.root, "package.json"), "utf8").includes("9.99.0"), false);
    assert.match(readFileSync(report.steps[0].log, "utf8"), /version not found/);
  } finally {
    process.chdir(previous); process.env.PATH = path;
    if (reportDirectory) rmSync(reportDirectory, { recursive: true, force: true });
    f.cleanup();
  }
});

for (const scenario of ["只报告", "失败后继续", "应用", "工作区变动", "包测试失败"]) {
  test(`离线流程：${scenario}`, async () => {
    const f = fixture();
    const previous = process.cwd(), path = process.env.PATH;
    let reportDirectory;
    try {
      execFileSync("git", ["init", "-q", f.root]);
      mkdirSync(join(f.root, "local/new-owner"), { recursive: true });
      mkdirSync(join(f.root, "local/union-owner"), { recursive: true });
      mkdirSync(join(f.root, "fork/forks"), { recursive: true });
      json(join(f.root, "package.json"), { workspaces: ["local/*", "fork/*"], devDependencies: { "@earendil-works/pi-ai": "1.5.0" } });
      json(join(f.root, "local/new-owner/package.json"), { name: "new-owner", scripts: { test: "unit", "check:internals": "probe", "check:host": "host", "test:patched-host": "excluded" }, peerDependencies: { "@earendil-works/pi-ai": "^1.5.0" } });
      json(join(f.root, "local/union-owner/package.json"), { name: "union-owner", scripts: { test: "unit", "check:internals": "probe" }, peerDependencies: { "@earendil-works/pi-ai": "*" } });
      json(join(f.root, "fork/forks/package.json"), { name: "forked", scripts: { test: "unit" }, peerDependencies: { "@earendil-works/pi-ai": "^1.5.0" } });
      writeFileSync(join(f.root, "bun.lock"), "original lock\n");
      writeFileSync(join(f.root, "guard.txt"), "original\n");
      if (scenario === "失败后继续") writeFileSync(join(f.root, "FAIL_TYPECHECK"), "");
      if (scenario === "包测试失败") writeFileSync(join(f.root, "FAIL_TEST_new-owner"), "");
      execFileSync("git", ["-C", f.root, "add", "."]);
      execFileSync("git", ["-C", f.root, "-c", "user.name=测试", "-c", "user.email=test@example.invalid", "commit", "-qm", "离线流程夹具"]);
      const before = readFileSync(join(f.root, "package.json"), "utf8");
      mkdirSync(join(f.root, "bin"));
      writeFileSync(join(f.root, ".git/info/exclude"), "bin/\nFAIL_TYPECHECK\nFAIL_TEST_*\n");
      const concurrentEdit = scenario === "工作区变动" ? `if [ "$2" = typecheck ]; then echo changed >> "${join(f.root, "guard.txt")}"; fi\n` : "";
      writeFileSync(join(f.root, "bin/npm"), `#!/bin/sh
if [ "$1" = view ]; then echo registry-notice >&2; printf '"%s"\n' "\${2##*@}"; exit 0; fi
printf "%s\\n" "$*"
if [ "$1" = run ] && [ "$2" = typecheck ] && [ -f FAIL_TYPECHECK ]; then echo "local/new-owner/file.ts(1,1): error TS2322: fixture mismatch"; exit 1; fi
if [ "$1" = run ] && [ "$2" = test ] && [ -f "FAIL_TEST_$4" ]; then echo "✖ fixture failure in $4"; exit 1; fi
` + concurrentEdit, { mode: 0o755 });
      writeFileSync(join(f.root, "bin/bun"), '#!/bin/sh\nprintf "target lock\\n" > bun.lock\n', { mode: 0o755 });
      process.env.PATH = `${join(f.root, "bin")}:${path}`;
      process.chdir(f.root);
      const originalLog = console.log, lines = [];
      console.log = (...args) => lines.push(args.join(" "));
      let result;
      try { result = await main(["1.6.0", ...(scenario === "只报告" ? [] : ["--apply"])]); }
      finally { console.log = originalLog; }
      reportDirectory = lines.join("\n").match(/报告：(.*)\/report.json/)[1];
      const report = JSON.parse(readFileSync(join(reportDirectory, "report.json")));
      const reportText = readFileSync(join(reportDirectory, "report.json"), "utf8");
      if (process.platform === "darwin") assert.match(report.directory, /^\/tmp\/pi-upgrade-/);
      assert.throws(() => readFileSync(join(reportDirectory, "repository/package.json")), { code: "ENOENT" });
      assert.equal(result, ["失败后继续", "工作区变动", "包测试失败"].includes(scenario) ? 1 : 0);
      // 逐包结果：根 npm test 不再进入门禁，每个包单独一条。
      for (const item of ["typecheck", "test:integration", "check:internals", "check:host"]) assert.ok(report.steps.some(step => step.item === item), item);
      for (const pkg of ["new-owner", "union-owner", "forked"]) {
        assert.ok(report.steps.some(step => step.package === pkg && step.item === "test"), pkg);
      }
      assert.equal(report.steps.some(step => step.package === "仓库" && step.item === "test"), false);
      assert.equal(report.steps.some(step => step.item === "test:patched-host"), false);
      assert.equal(report.steps.find(step => step.item === "check:host").status, "passed");
      if (scenario === "应用") {
        assert.equal(JSON.parse(readFileSync(join(f.root, "package.json"))).devDependencies["@earendil-works/pi-ai"], "1.6.0");
        assert.equal(JSON.parse(readFileSync(join(f.root, "local/new-owner/package.json"))).peerDependencies["@earendil-works/pi-ai"], "^1.6.0");
        assert.equal(JSON.parse(readFileSync(join(f.root, "local/union-owner/package.json"))).peerDependencies["@earendil-works/pi-ai"], "*");
        assert.equal(JSON.parse(readFileSync(join(f.root, "fork/forks/package.json"))).peerDependencies["@earendil-works/pi-ai"], "^1.5.0");
        assert.equal(readFileSync(join(f.root, "bun.lock"), "utf8"), "target lock\n");
        assert.ok(report.manual.some(item => item.package === "union-owner" && item.reason.includes("人工处理")));
        assert.ok(report.manual.some(item => item.package === "forked" && item.reason.includes("LOCAL_PATCHES")));
        assert.match(reportText, /LOCAL_PATCHES\.md/);
      } else {
        assert.equal(readFileSync(join(f.root, "package.json"), "utf8"), before);
        assert.equal(readFileSync(join(f.root, "bun.lock"), "utf8"), "original lock\n");
      }
      if (scenario === "工作区变动") {
        assert.equal(report.steps.at(-1).status, "failed");
        assert.match(report.steps.at(-1).reason, /拒绝 --apply/);
      }
      if (scenario === "失败后继续") {
        assert.equal(report.steps.find(step => step.item === "typecheck").failures[0].package, "new-owner");
        assert.ok(report.steps.filter(step => step.item === "test").every(step => step.status === "passed"));
      }
      if (scenario === "包测试失败") {
        assert.equal(report.steps.find(step => step.package === "new-owner" && step.item === "test").status, "failed");
        assert.equal(report.steps.find(step => step.package === "union-owner" && step.item === "test").status, "passed");
        assert.equal(report.steps.find(step => step.item === "test:integration").status, "passed");
        assert.equal(report.steps.find(step => step.item === "check:internals").status, "passed");
        assert.equal(report.steps.at(-1).item, "--apply");
        assert.equal(report.steps.at(-1).status, "skipped");
      }
    } finally {
      process.chdir(previous); process.env.PATH = path;
      if (reportDirectory) rmSync(reportDirectory, { recursive: true, force: true });
      f.cleanup();
    }
  });
}
