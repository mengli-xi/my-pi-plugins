import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { upgrade, download } from "./fork-upgrade.mjs";

function fixture(t) {
  const temp = mkdtempSync(path.join(tmpdir(), "fork-upgrade-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "离线测试"); git("config", "user.email", "test@example.invalid");
  const prefix = "fork/pi-demo";
  const put = (filename, text) => { mkdirSync(path.dirname(path.join(root, filename)), { recursive: true }); writeFileSync(path.join(root, filename), text); };
  const registry = pathToFileURL(`${temp}/registry/`).href;
  put(`${prefix}/UPSTREAM.json`, JSON.stringify({ type: "npm", package: "demo", version: "1.0.0", registry }));
  put(`${prefix}/index.txt`, "上游旧值\n");
  put("fork/pi-other/unchanged.txt", "其他包原版\n");
  git("add", "."); git("commit", "-qm", "上游原版"); git("branch", "vendor/upstream");
  put("README.md", "主分支\n"); put(`${prefix}/local.txt`, "本地补丁\n");
  git("add", "."); git("commit", "-qm", "本地补丁");
  const packageDir = path.join(temp, "tar/package"); mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "index.txt"), "上游新值\n");
  const tarball = path.join(temp, "new.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(packageDir), "package"]);
  const bytes = readFileSync(tarball);
  const info = { name: "demo", version: "2.0.0", dist: { tarball: pathToFileURL(tarball).href, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } };
  const meta = path.join(temp, "registry/demo/2.0.0"); mkdirSync(path.dirname(meta), { recursive: true });
  const saveMeta = () => writeFileSync(meta, JSON.stringify(info)); saveMeta();
  const run = options => upgrade({ root, fork: "pi-demo", version: "2.0.0", log: () => {}, ...options });
  return { root, git, put, run, prefix, info, saveMeta, temp };
}

test("正常升级只替换一个原版目录、保留补丁并 merge，同时更新双方来源", async t => {
  const f = fixture(t);
  const before = f.git("rev-parse", "vendor/upstream");
  const result = await f.run();
  assert.equal(f.git("show", "HEAD:fork/pi-demo/index.txt"), "上游新值");
  assert.equal(f.git("show", "HEAD:fork/pi-demo/local.txt"), "本地补丁");
  assert.equal(f.git("show", "vendor/upstream:fork/pi-other/unchanged.txt"), "其他包原版");
  assert.equal(f.git("rev-parse", "vendor/upstream^"), before);
  assert.equal(f.git("merge-base", "HEAD", "vendor/upstream"), result.commit);
  assert.equal(f.git("show", "HEAD:fork/pi-demo/UPSTREAM.json"), f.git("show", "vendor/upstream:fork/pi-demo/UPSTREAM.json"));
  assert.equal(JSON.parse(f.git("show", "HEAD:fork/pi-demo/UPSTREAM.json")).version, "2.0.0");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("冲突保留 merge 状态，报告文件与人工下一步，不解决", async t => {
  const f = fixture(t);
  f.put(`${f.prefix}/index.txt`, "本地改同一行\n"); f.git("add", "."); f.git("commit", "-qm", "冲突补丁");
  await assert.rejects(f.run(), /合并停止[\s\S]*fork\/pi-demo\/index.txt[\s\S]*git add[\s\S]*git merge --abort/);
  assert.match(f.git("diff", "--name-only", "--diff-filter=U"), /index.txt/);
  assert.equal(f.git("show", "vendor/upstream:fork/pi-demo/index.txt"), "上游新值");
});

test("integrity 不符不更新任何分支或工作区", async t => {
  const f = fixture(t); const before = f.git("rev-parse", "vendor/upstream");
  f.info.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`; f.saveMeta();
  await assert.rejects(f.run(), /integrity 校验不符/);
  assert.equal(f.git("rev-parse", "vendor/upstream"), before); assert.equal(f.git("status", "--porcelain"), "");
});

test("脏工作区（未跟踪、已跟踪和暂存）在下载前拒绝", async t => {
  const f = fixture(t);
  for (const filename of ["untracked", "README.md", `${f.prefix}/local.txt`]) {
    f.put(filename, "脏\n");
    if (filename.endsWith("local.txt")) f.git("add", filename);
    await assert.rejects(f.run({ download: () => assert.fail("不应下载") }), /工作区不干净/);
    f.git("reset", "--hard", "-q"); f.git("clean", "-fdq");
  }
});

test("dry-run 校验并报告差异，不提交；相同版本逐字节比对", async t => {
  const f = fixture(t); const before = f.git("rev-parse", "vendor/upstream");
  assert.equal((await f.run({ dryRun: true })).identical, false);
  assert.equal(f.git("rev-parse", "vendor/upstream"), before); assert.equal(f.git("status", "--porcelain"), "");
  await f.run(); assert.equal((await f.run({ dryRun: true })).identical, true);
});

test("拒绝带符号链接的 tarball，即使 integrity 正确", async t => {
  const f = fixture(t);
  const { symlinkSync } = await import("node:fs");
  symlinkSync("/tmp", path.join(f.temp, "tar/package/escape"));
  execFileSync("tar", ["-czf", path.join(f.temp, "new.tgz"), "-C", path.join(f.temp, "tar"), "package"]);
  const bytes = await download(f.info.dist.tarball);
  f.info.dist.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`; f.saveMeta();
  await assert.rejects(f.run(), /归档只允许普通文件/);
});
