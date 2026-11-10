#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorRef = "refs/heads/vendor/upstream";
const json = value => `${JSON.stringify(value, null, 2)}\n`;

export async function download(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") return readFileSync(parsed);
  if (parsed.protocol !== "https:") throw new Error("来源只支持 https: 或 file:");
  const response = await fetch(parsed, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export function verifyIntegrity(bytes, integrity) {
  // SRI 多摘要使用最强的受支持算法，不能让弱摘要绕过强摘要的不匹配。
  const tokens = String(integrity).split(/\s+/).map(token => token.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/)).filter(Boolean);
  const algorithm = ["sha512", "sha384", "sha256"].find(name => tokens.some(token => token[1] === name));
  if (!algorithm) throw new Error("缺少受支持的 integrity");
  const actual = createHash(algorithm).update(bytes).digest();
  if (!tokens.filter(token => token[1] === algorithm).some(token => {
    const expected = Buffer.from(token[2], "base64");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  })) throw new Error("integrity 校验不符，拒绝导入");
}

function unpack(archive, directory) {
  const run = args => execFileSync("tar", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const names = run(["-tf", archive]).trim().split("\n");
  for (const name of names) {
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) throw new Error(`不安全的归档路径: ${name}`);
  }
  // 不接受 symlink、hardlink、设备等，避免解包写出临时目录。
  for (const line of run(["-tvf", archive]).trim().split("\n")) {
    if (!/^[-d]/.test(line)) throw new Error("归档只允许普通文件和目录");
  }
  mkdirSync(directory);
  run(["-xf", archive, "-C", directory, "--no-same-owner", "--no-same-permissions"]);
  return names[0].split("/")[0];
}

function gitRunner(root, extraEnv = {}) {
  return (args, input) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root, env: { ...process.env, ...extraEnv }, input, encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// 暴露下载注入点供离线合同测试；CLI 不使用环境变量切换生产来源。
export async function upgrade({ root = process.cwd(), fork, version, dryRun = false, download: get = download, log = console.log }) {
  if (!/^pi-[a-z0-9-]+$/.test(fork ?? "") || !version || version.startsWith("-")) throw new Error("用法: node scripts/fork-upgrade.mjs <fork> <版本或tag> [--dry-run]");
  const git = gitRunner(root);
  root = git(["rev-parse", "--show-toplevel"]);
  if (git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("工作区不干净，请先提交或暂存到 stash（含未跟踪文件）");
  const branch = git(["symbolic-ref", "--short", "HEAD"]);
  if (branch === "vendor/upstream") throw new Error("不能在 vendor/upstream 上运行升级");
  const oldVendor = git(["rev-parse", vendorRef]);
  git(["merge-base", "--is-ancestor", oldVendor, "HEAD"]);
  const prefix = `fork/${fork}`;
  const metadataPath = `${prefix}/UPSTREAM.json`;
  const previous = JSON.parse(readFileSync(path.join(root, metadataPath), "utf8"));
  const temp = mkdtempSync(path.join(tmpdir(), "pi-fork-upgrade-"));
  try {
    let metadata, bytes, subdirectory;
    if (previous.type === "npm") {
      const registry = previous.registry ?? "https://registry.npmjs.org/";
      const info = JSON.parse((await get(new URL(`${encodeURIComponent(previous.package)}/${encodeURIComponent(version)}`, registry).href)).toString());
      if (info.name !== previous.package || info.version !== version) throw new Error("registry 包名或版本不匹配");
      bytes = await get(info.dist.tarball);
      verifyIntegrity(bytes, info.dist.integrity);
      metadata = { type: "npm", package: info.name, version: info.version, registry, tarball: info.dist.tarball, integrity: info.dist.integrity };
      subdirectory = "package";
    } else if (previous.type === "git") {
      const repository = previous.repository.replace(/\.git$/, "");
      const match = repository.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/);
      if (!match) throw new Error("git 来源必须为 GitHub 仓库");
      const info = JSON.parse((await get(`https://api.github.com/repos/${match[1]}/commits/${encodeURIComponent(version)}`)).toString());
      if (!/^[a-f0-9]{40}$/.test(info.sha)) throw new Error("GitHub 未返回有效 commit");
      bytes = await get(`https://codeload.github.com/${match[1]}/tar.gz/${info.sha}`);
      metadata = { type: "git", repository: previous.repository, tag: version, commit: info.sha, subdirectory: previous.subdirectory, sha256: createHash("sha256").update(bytes).digest("hex") };
    } else throw new Error("未知来源类型");
    const archive = path.join(temp, "source.tgz");
    writeFileSync(archive, bytes);
    const extraction = path.join(temp, "unpacked");
    const top = unpack(archive, extraction);
    if (metadata.type === "git") {
      if (typeof metadata.subdirectory !== "string" || metadata.subdirectory.split("/").includes("..") || path.isAbsolute(metadata.subdirectory)) throw new Error("无效的上游子目录");
      subdirectory = path.join(top, metadata.subdirectory);
    }
    const source = path.join(extraction, subdirectory);
    if (!lstatSync(source).isDirectory()) throw new Error("归档缺少所需包目录");
    const indexGit = gitRunner(root, { GIT_INDEX_FILE: path.join(temp, "index") });
    indexGit(["read-tree", oldVendor]);
    const oldFiles = indexGit(["ls-files", "-z", "--", prefix]);
    if (oldFiles) indexGit(["update-index", "--force-remove", "-z", "--stdin"], oldFiles);
    const records = [];
    function add(directory, relative = "") {
      for (const name of readdirSync(directory).sort()) {
        if ([".git", "UPSTREAM.json"].includes(name) && !relative) {
          if (name === ".git") throw new Error("上游包不能包含 .git");
          continue;
        }
        const filename = path.join(directory, name);
        const stat = lstatSync(filename);
        const target = path.posix.join(prefix, relative, name);
        if (stat.isDirectory()) add(filename, path.posix.join(relative, name));
        else if (stat.isFile()) {
          const blob = indexGit(["hash-object", "-w", "--stdin"], readFileSync(filename));
          records.push(`${stat.mode & 0o111 ? "100755" : "100644"} ${blob}\t${target}\0`);
        } else throw new Error(`不支持的文件: ${filename}`);
      }
    }
    add(source);
    const blob = indexGit(["hash-object", "-w", "--stdin"], json(metadata));
    records.push(`100644 ${blob}\t${metadataPath}\0`);
    indexGit(["update-index", "-z", "--index-info"], records.join(""));
    const tree = indexGit(["write-tree"]);
    const differences = git(["diff", "--name-status", oldVendor, tree, "--", prefix, `:(exclude)${metadataPath}`]);
    log(differences || `${fork}: 原版文件逐字节一致（含文件模式，不计 UPSTREAM.json 来源记录）`);
    if (dryRun) { log("dry-run：已下载、校验、展开；未提交、未更新分支或工作区"); return { identical: !differences, metadata }; }
    // 下载期间可能有其他操作，提交前重新检查，不覆盖并发分支更新。
    if (git(["status", "--porcelain", "--untracked-files=all"]) || git(["symbolic-ref", "--short", "HEAD"]) !== branch) throw new Error("下载期间工作区或分支改变，拒绝提交");
    const commit = git(["commit-tree", tree, "-p", oldVendor, "-m", `导入 ${fork} 上游原版 ${version}`]);
    git(["update-ref", vendorRef, commit, oldVendor]);
    // UPSTREAM.json 随 vendor merge 同时进入当前分支，不另造 main-only 修改。
    const merge = spawnSync("git", ["-c", "core.fsmonitor=false", "merge", "--no-edit", "-m", `合并 ${fork} 上游原版 ${version}`, "vendor/upstream"], { cwd: root, encoding: "utf8" });
    log(merge.stdout ?? "");
    if (merge.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"]);
      throw new Error(`合并停止，vendor 提交 ${commit} 已保留。冲突文件：\n${conflicts || "（无冲突文件，请检查 Git 错误）"}\n${merge.stderr ?? ""}\n下一步：手动解冲突，git add 后 git commit；按 LOCAL_PATCHES.md 复查并运行测试。放弃本次合并用 git merge --abort；vendor 原版仍保留，可重新 merge vendor/upstream。`);
    }
    return { commit, metadata };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter(arg => arg !== "--dry-run");
  try {
    if (positional.length !== 2 || args.length !== positional.length + Number(dryRun)) throw new Error("用法: node scripts/fork-upgrade.mjs <fork> <版本或tag> [--dry-run]");
    await upgrade({ fork: positional[0], version: positional[1], dryRun });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
