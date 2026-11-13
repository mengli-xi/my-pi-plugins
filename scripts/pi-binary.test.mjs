import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { binarySource, checksumFor, productionPlugins } from "./pi-binary.mjs";
import { installedPiVersion, parseHostSuites, repositoryRoot, workspacePackages } from "./pi-checks.mjs";
import { fakeRelease } from "./fixtures/fake-release.mjs";

test("官方资产只接受 darwin/linux × arm64/x64", () => {
  for (const os of ["darwin", "linux"]) for (const arch of ["arm64", "x64"]) {
    const source = binarySource("1.5.2", os, arch);
    assert.equal(source.asset, `pi-${os}-${arch}.tar.gz`);
    assert.equal(source.url, `https://github.com/earendil-works/pi/releases/download/v1.5.2/${source.asset}`);
  }
  for (const [os, arch] of [["win32", "x64"], ["linux", "ia32"]]) assert.throws(() => binarySource("1.5.2", os, arch));
});

test("SHA256SUMS 精确匹配、支持文本/二进制标记，缺项、重复及坏行失败", () => {
  const hash = "ab".repeat(32);
  assert.equal(checksumFor(`${hash.toUpperCase()} *pi.tgz\r\n${"cd".repeat(32)}  other\n`, "pi.tgz"), hash);
  for (const text of ["", `${hash}  other`, `${hash}  pi.tgz\n${hash}  pi.tgz`, "bad  pi.tgz", `${hash}  pi.tgz\nbroken`]) assert.throws(() => checksumFor(text, "pi.tgz"));
});

test("host 跳过理由属于子套件声明，普通命令不被改写", () => {
  const suites = parseHostSuites(["--skip-binary=需要 npm SDK，不能执行二进制 CLI", "node", "probe.mjs", "::", "--require=pty", "bun", "real.mjs"]);
  assert.deepEqual(suites, [
    { args: ["node", "probe.mjs"], requires: [], binarySkip: "需要 npm SDK，不能执行二进制 CLI" },
    { args: ["bun", "real.mjs"], requires: ["pty"], binarySkip: undefined },
  ]);
  for (const args of [["--skip-binary=", "node"], ["--skip-binary=a", "--skip-binary=b", "node"], ["--require=unknown", "node"], ["node", "::"]]) assert.throws(() => parseHostSuites(args));
});

test("生产插件由 README 索引决定，排除共享库与开发 Gallery", () => {
  const packages = workspacePackages(repositoryRoot);
  const selected = productionPlugins(packages, readFileSync(join(repositoryRoot, "README.md"), "utf8"));
  assert.ok(selected.length > 20);
  assert.ok(selected.every(pkg => pkg.pi.extensions.length));
  assert.ok(selected.some(pkg => pkg.name === "pi-perf"));
  assert.ok(!selected.some(pkg => /gallery|runtime-contracts/.test(pkg.name)));
  assert.throws(() => productionPlugins([], "missing"));
  assert.throws(() => productionPlugins([], "| [x](local/x/README.md) | 插件 | x |"));
});

test("索引反查拒绝未列出、格式漏解析或误标共享库的 extension 包", () => {
  const packages = ["production", "new-plugin"].map(name => ({ directory: `local/${name}`, pi: { extensions: ["index.ts"] } }));
  const production = "| [production](local/production/README.md) | 插件 | 用途包含开发用也仍是生产插件 |";
  for (const row of ["", "| **[new](local/new-plugin/README.md)** | 插件 | 格式变化 |", "| [new](local/new-plugin/README.md) | 共享库 | 误标 |"])
    assert.throws(() => productionPlugins(packages, production + "\n" + row), /local\/new-plugin/);
  for (const type of ["开发插件", "示例插件"]) {
    assert.equal(productionPlugins(packages, production + `\n|[new](local/new-plugin/README.md)| ${type} | 明确非生产 |`).length, 1);
  }
  assert.equal(productionPlugins(packages, production + "\n  |[new](local/new-plugin/README.md)| Fork   插件 | 宽松空白 |").length, 2);
});

test("包声明中的带空格跳过理由经 shell 后仍是单个参数", () => {
  const root = mkdtempSync(join(tmpdir(), "binary-declarations-"));
  try {
    const fixture = join(root, "args.mjs");
    writeFileSync(fixture, "console.log(JSON.stringify(process.argv.slice(2)))");
    const owners = workspacePackages(repositoryRoot).filter(pkg => pkg.scripts?.["check:host"]?.includes("--skip-binary="));
    assert.ok(owners.length > 0);
    for (const pkg of owners) {
      const command = pkg.scripts["check:host"].replace("node ../../scripts/check-host.mjs", `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`);
      const result = spawnSync("/bin/sh", ["-c", command], { cwd: join(repositoryRoot, pkg.directory), encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const skips = parseHostSuites(JSON.parse(result.stdout.trim())).filter(suite => suite.binarySkip);
      assert.ok(skips.length > 0, pkg.name);
      for (const suite of skips) assert.match(suite.binarySkip, /\S \S/, pkg.name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("仅官方二进制模式接受显式跳过，后续真实套件仍执行", () => {
  const root = mkdtempSync(join(tmpdir(), "binary-skip-unit-"));
  try {
    const binary = join(root, "pi");
    writeFileSync(binary, `#!/bin/sh\necho ${installedPiVersion()}\n`, { mode: 0o755 });
    for (const binaryMode of ["0", "1"]) {
      const report = join(root, `host-${binaryMode}.json`);
      const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts/check-host.mjs"),
        "--skip-binary=需要 npm SDK，不能执行二进制 CLI", process.execPath, "-e", "process.exit(3)", "::", process.execPath, "-e", "console.log('REAL_CLI_SUITE')",
      ], { env: { ...process.env, PI_BIN: binary, PI_CHECK_BINARY: binaryMode, PI_CHECK_REPORT: report }, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, binaryMode === "1" ? 0 : 1, result.stdout + result.stderr);
      const suites = JSON.parse(readFileSync(report));
      assert.deepEqual(suites.map(suite => suite.status), [binaryMode === "1" ? "skipped" : "failed", "passed"]);
      if (binaryMode === "1") assert.equal(suites[0].reason, "需要 npm SDK，不能执行二进制 CLI");
      assert.match(result.stdout, /REAL_CLI_SUITE/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["passed", "hash", "missing", "version", "http-proxy", "isolation"]) test(`离线下载/解压/版本门禁：${mode}`, () => {
  const root = mkdtempSync(join(tmpdir(), "binary-unit-"));
  try {
    const versionProbe = mode === "isolation" ? `env > '${join(root, "version-env")}'\npwd > '${join(root, "version-cwd")}'` : "";
    const hash = fakeRelease(root, mode === "version" ? "1.5.1" : "1.5.2", { badHash: mode === "hash", missing: mode === "missing", versionProbe });
    const directory = join(root, "download");
    const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` };
    if (mode === "isolation") Object.assign(env, {
      HOME: join(root, "daily-home"), PI_CODING_AGENT_DIR: join(root, "daily-agent"),
      PI_CODING_AGENT_SESSION_DIR: join(root, "daily-sessions"), XDG_CONFIG_HOME: join(root, "daily-config"),
      OPENAI_API_KEY: "must-not-leak", PI_PACKAGE_DIR: join(root, "daily-package"),
    });
    if (mode === "http-proxy") {
      for (const key of ["HTTPS_PROXY", "https_proxy", "http_proxy"]) delete env[key];
      env.HTTP_PROXY = "http://proxy.example.invalid:8080";
      const curl = join(root, "bin/curl");
      writeFileSync(curl, readFileSync(curl, "utf8").replace("#!/bin/sh", '#!/bin/sh\n[ "$https_proxy" = "http://proxy.example.invalid:8080" ] || exit 23'));
    }
    const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts/pi-binary.mjs"), "1.5.2", directory], { env, encoding: "utf8", timeout: 30_000 });
    const passed = ["passed", "http-proxy", "isolation"].includes(mode);
    assert.equal(result.status, passed ? 0 : 1, result.stdout + result.stderr);
    if (passed) {
      const metadata = JSON.parse(readFileSync(join(directory, "metadata.json")));
      assert.equal(metadata.sha256, hash);
      assert.equal(metadata.version, "1.5.2");
      assert.ok(existsSync(metadata.binary));
      if (mode === "isolation") {
        const versionEnv = Object.fromEntries(readFileSync(join(root, "version-env"), "utf8").trim().split("\n").map(line => {
          const equal = line.indexOf("="); return [line.slice(0, equal), line.slice(equal + 1)];
        }));
        for (const key of ["HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR"])
          assert.ok(versionEnv[key]?.startsWith(join(directory, "version-environment") + "/"), key);
        for (const key of ["OPENAI_API_KEY", "PI_PACKAGE_DIR"]) assert.equal(versionEnv[key], undefined, key);
        assert.equal(realpathSync(readFileSync(join(root, "version-cwd"), "utf8").trim()), realpathSync(join(directory, "version-environment")));
      }
    } else {
      assert.equal(existsSync(join(directory, "metadata.json")), false);
      if (mode !== "version") assert.equal(existsSync(join(directory, "extracted")), false, "未校验的资产不能解压");
      if (mode === "version") assert.match(result.stderr, /1.5.1 != 1.5.2/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
