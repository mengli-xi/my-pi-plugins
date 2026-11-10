import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { upgrade, download, parseArgs } from "./fork-upgrade.mjs";

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
  const tarball = path.join(temp, "new.tgz");
  const registry = pathToFileURL(`${temp}/registry/`).href;
  put(`${prefix}/UPSTREAM.json`, JSON.stringify({ type: "npm", package: "demo", version: "1.0.0", registry, tarball: pathToFileURL(tarball).href }));
  put(`${prefix}/index.txt`, "上游旧值\n");
  put("fork/pi-other/unchanged.txt", "其他包原版\n");
  git("add", "."); git("commit", "-qm", "上游原版"); git("branch", "vendor/upstream");
  put("README.md", "主分支\n"); put(`${prefix}/local.txt`, "本地补丁\n");
  git("add", "."); git("commit", "-qm", "本地补丁");
  const packageDir = path.join(temp, "tar/package"); mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "index.txt"), "上游新值\n");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(packageDir), "package"]);
  const bytes = readFileSync(tarball);
  const info = { name: "demo", version: "2.0.0", dist: { tarball: "https://example.invalid/demo.tgz", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } };
  const meta = path.join(temp, "registry/demo/2.0.0"); mkdirSync(path.dirname(meta), { recursive: true });
  const saveMeta = () => writeFileSync(meta, JSON.stringify(info)); saveMeta();
  const run = options => upgrade({ root, fork: "pi-demo", version: "2.0.0", log: () => {}, ...options });
  return { root, git, put, run, prefix, info, saveMeta, temp, registry, tarball };
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
  const bytes = await download(pathToFileURL(f.tarball).href);
  f.info.dist.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`; f.saveMeta();
  await assert.rejects(f.run(), /归档只允许普通文件/);
});


test("git codeload 来源按子目录导入，记录 commit 和 sha256，可从包目录启动", async t => {
  const f = fixture(t);
  const previous = { type: "git", repository: "https://github.com/example/repo.git", tag: "v1", commit: "1".repeat(40), subdirectory: "extensions/goal" };
  f.git("checkout", "-q", "vendor/upstream");
  f.put(`${f.prefix}/UPSTREAM.json`, JSON.stringify(previous, null, 2) + "\n");
  f.git("add", "."); f.git("commit", "-qm", "git 来源");
  f.git("checkout", "-q", "main"); f.git("merge", "--no-edit", "vendor/upstream");
  const top = path.join(f.temp, "github/repo-commit");
  mkdirSync(path.join(top, "extensions/goal"), { recursive: true });
  writeFileSync(path.join(top, "extensions/goal/index.txt"), "Goal 新原版\n");
  writeFileSync(path.join(top, "ignored.txt"), "其他上游内容\n");
  const tarball = path.join(f.temp, "git.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(top), "repo-commit"]);
  const bytes = readFileSync(tarball);
  const sha = "2".repeat(40);
  const urls = [];
  const result = await f.run({ root: path.join(f.root, f.prefix), version: "v2", download: async url => {
    urls.push(url);
    if (url === "https://api.github.com/repos/example/repo/commits/v2") return Buffer.from(JSON.stringify({ sha }));
    assert.equal(url, `https://codeload.github.com/example/repo/tar.gz/${sha}`);
    return bytes;
  } });
  assert.equal(urls.length, 2);
  assert.equal(result.metadata.commit, sha);
  assert.equal(result.metadata.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(f.git("show", "HEAD:fork/pi-demo/index.txt"), "Goal 新原版");
  assert.equal(f.git("ls-tree", "--name-only", "vendor/upstream:fork/pi-demo"), "UPSTREAM.json\nindex.txt");
});

test("下载期间当前分支发生干净提交时拒绝，不推进 vendor", async t => {
  const f = fixture(t); const before = f.git("rev-parse", "vendor/upstream");
  let changed = false;
  await assert.rejects(f.run({ download: async url => {
    if (!changed) { changed = true; f.git("commit", "--allow-empty", "-qm", "并发提交"); }
    return download(url);
  } }), /下载期间工作区或分支改变/);
  assert.equal(f.git("rev-parse", "vendor/upstream"), before);
});


test("冲突 abort 后重跑明确提示先 merge，不下载、不产生原始 Git 报错", async t => {
  const f = fixture(t);
  f.put(`${f.prefix}/index.txt`, "本地冲突\n"); f.git("add", "."); f.git("commit", "-qm", "冲突");
  await assert.rejects(f.run(), /合并停止/);
  f.git("merge", "--abort");
  await assert.rejects(f.run({ download: () => assert.fail("不应下载") }), /先执行 git merge vendor\/upstream[\s\S]*然后再升级/);
});

test("detached HEAD 与无共同祖先的 vendor 分别清楚拒绝", async t => {
  const f = fixture(t);
  f.git("checkout", "--detach", "-q");
  await assert.rejects(f.run(), /detached HEAD[\s\S]*git switch/);
  f.git("checkout", "-q", "main");
  const orphan = f.git("commit-tree", f.git("rev-parse", "HEAD^{tree}"), "-m", "无关原版");
  f.git("update-ref", "refs/heads/vendor/upstream", orphan);
  await assert.rejects(f.run(), /不在当前分支的谱系上（没有共同祖先）/);
});

test("exclude 在首次导入与后续升级时都跳过生成物，dry-run 不写对象库", async t => {
  const f = fixture(t);
  const packageDir = path.join(f.temp, "tar/package");
  mkdirSync(path.join(packageDir, "dist"));
  writeFileSync(path.join(packageDir, "dist/generated.js"), "第一版产物");
  writeFileSync(path.join(packageDir, "CHANGELOG.md"), "发布记录");
  function pack() {
    execFileSync("tar", ["-czf", f.tarball, "-C", path.dirname(packageDir), "package"]);
    f.info.dist.integrity = `sha512-${createHash("sha512").update(readFileSync(f.tarball)).digest("base64")}`;
    f.saveMeta();
  }
  pack();
  const options = parseArgs(["pi-new", "2.0.0", "--npm", "demo", "--registry", f.registry, "--tarball", pathToFileURL(f.tarball).href, "--exclude", "dist/", "--exclude", "CHANGELOG.md"]);
  const objectFiles = () => execFileSync("git", ["count-objects", "-v"], { cwd: f.root, encoding: "utf8" });
  const objects = objectFiles(), head = f.git("rev-parse", "HEAD"), vendor = f.git("rev-parse", "vendor/upstream");
  assert.equal((await f.run({ ...options, dryRun: true })).identical, false);
  assert.equal(objectFiles(), objects);
  assert.equal(f.git("rev-parse", "HEAD"), head); assert.equal(f.git("rev-parse", "vendor/upstream"), vendor);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(path.join(f.root, "fork/pi-new")), false);
  await f.run(options);
  assert.equal(f.git("ls-tree", "--name-only", "vendor/upstream:fork/pi-new"), "UPSTREAM.json\nindex.txt");
  const metadata = JSON.parse(f.git("show", "HEAD:fork/pi-new/UPSTREAM.json"));
  assert.deepEqual(metadata.exclude, ["dist/", "CHANGELOG.md"]);
  assert.equal(metadata.tarball, pathToFileURL(f.tarball).href);
  writeFileSync(path.join(packageDir, "dist/generated.js"), "第二版产物");
  pack();
  const beforeObjects = objectFiles();
  assert.equal((await f.run({ fork: "pi-new", dryRun: true })).identical, true);
  assert.equal(objectFiles(), beforeObjects);
  await f.run({ fork: "pi-new" });
  assert.equal(f.git("ls-tree", "--name-only", "HEAD:fork/pi-new"), "UPSTREAM.json\nindex.txt");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("registry 返回 file: tarball 不能取得本地读取权限", async t => {
  const f = fixture(t);
  f.info.dist.tarball = pathToFileURL(f.tarball).href; f.saveMeta();
  const urls = [];
  await assert.rejects(f.run({ download: async url => { urls.push(url); return download(url); } }), /tarball URL 必须是 https/);
  assert.equal(urls.length, 1, "只读取显式 file: registry，拒绝读取元数据中的 file: tarball");
});

test("没有显式 file: tarball 时使用 registry 的 https tarball", async t => {
  const f = fixture(t);
  const metadata = JSON.parse(f.git("show", "HEAD:fork/pi-demo/UPSTREAM.json"));
  delete metadata.tarball;
  f.put(`${f.prefix}/UPSTREAM.json`, JSON.stringify(metadata)); f.git("add", "."); f.git("commit", "-qm", "只指定 registry");
  const urls = [];
  await f.run({ dryRun: true, download: async url => {
    urls.push(url);
    if (url.startsWith("file:")) return download(url);
    assert.equal(url, f.info.dist.tarball);
    return readFileSync(f.tarball);
  } });
  assert.equal(urls[1], f.info.dist.tarball);
});

test("exclude 先区分普通文件与目录：不扩大范围，类型不符时拒绝", async t => {
  const f = fixture(t);
  const packageDir = path.join(f.temp, "tar/package");
  const pack = () => {
    execFileSync("tar", ["-czf", f.tarball, "-C", path.join(f.temp, "tar"), "package"]);
    f.info.dist.integrity = `sha512-${createHash("sha512").update(readFileSync(f.tarball)).digest("base64")}`;
    f.saveMeta();
  };
  mkdirSync(path.join(packageDir, "src"));
  writeFileSync(path.join(packageDir, "src/inside.txt"), "源目录\n");
  mkdirSync(path.join(packageDir, "dist-extra"));
  writeFileSync(path.join(packageDir, "dist-extra/inside.txt"), "相似前缀\n");
  writeFileSync(path.join(packageDir, "dist"), "同名普通文件\n");
  pack();
  const first = exclude => ({ fork: "pi-new", version: "2.0.0", npm: "demo", registry: f.registry, tarball: pathToFileURL(f.tarball).href, exclude });
  const vendor = f.git("rev-parse", "vendor/upstream");
  // 文件规则 src 指向的是目录，不能借它排除整个 src/。
  await assert.rejects(f.run({ ...first(["src"]), dryRun: true }), /exclude 规则 src 指向普通文件，但上游的 src 不是普通文件；目录规则请写成 src\//);
  // 目录规则 dist/ 指向的是普通文件，不能排除它。
  await assert.rejects(f.run({ ...first(["dist/"]), dryRun: true }), /exclude 规则 dist\/ 指向目录，但上游的 dist 不是目录/);
  assert.equal(f.git("rev-parse", "vendor/upstream"), vendor);
  // 换成真正的目录后，dist/ 只排除 dist/，不影响 dist-extra/ 和文件规则之外的内容。
  rmSync(path.join(packageDir, "dist"));
  mkdirSync(path.join(packageDir, "dist"));
  writeFileSync(path.join(packageDir, "dist/generated.js"), "生成物\n");
  pack();
  await f.run({ ...first(["dist/"]) });
  assert.deepEqual(f.git("ls-tree", "-r", "--name-only", "vendor/upstream:fork/pi-new").split("\n"), [
    "UPSTREAM.json", "dist-extra/inside.txt", "index.txt", "src/inside.txt",
  ]);
  assert.equal(f.git("status", "--porcelain"), "");
});
