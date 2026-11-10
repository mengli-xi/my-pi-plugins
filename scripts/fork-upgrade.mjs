#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function gitStatus(root, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`Git 状态检查失败：${result.error?.message ?? result.stderr}`);
  return result;
}

function checkExclude(exclude = []) {
  if (!Array.isArray(exclude) || exclude.some(item => typeof item !== "string" ||
    !item || item.startsWith("/") || /[\\*?\[\]\x00-\x1f]/.test(item) ||
    item.replace(/\/$/, "").split("/").some(part => !part || part === "." || part === "..") ||
    item === "UPSTREAM.json")) throw new Error("exclude 必须是包内文件路径或以 / 结尾的目录前缀，不支持 glob");
  return exclude;
}

const usage = "用法: node scripts/fork-upgrade.mjs <fork> <版本或tag> [--dry-run] [--npm <包名> | --git <GitHub url> --subdir <路径>] [--registry <url>] [--tarball <file:url>] [--exclude <路径>]";

export function parseArgs(args) {
  const options = { exclude: [] };
  const positional = [];
  const flags = { "--npm": "npm", "--git": "repository", "--subdir": "subdirectory", "--registry": "registry", "--tarball": "tarball", "--exclude": "exclude" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run" && !options.dryRun) options.dryRun = true;
    else if (Object.hasOwn(flags, arg)) {
      const key = flags[arg], value = args[++i];
      if (!value || value.startsWith("-") || key !== "exclude" && options[key] !== undefined) throw new Error(usage);
      if (key === "exclude") options.exclude.push(value);
      else options[key] = value;
    } else if (arg.startsWith("-")) throw new Error(usage);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new Error(usage);
  return { ...options, fork: positional[0], version: positional[1] };
}

// 暴露下载注入点供离线合同测试；CLI 不使用环境变量切换生产来源。
export async function upgrade({ root = process.cwd(), fork, version, dryRun = false, npm, repository, subdirectory: requestedSubdir, registry: requestedRegistry, tarball: requestedTarball, exclude: requestedExclude = [], download: get = download, log = console.log }) {
  if (!/^pi-[a-z0-9-]+$/.test(fork ?? "") || !version || version.startsWith("-")) throw new Error(usage);
  let git = gitRunner(root);
  root = git(["rev-parse", "--show-toplevel"]);
  git = gitRunner(root);
  const initialHead = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("工作区不干净，请先提交或暂存到 stash（含未跟踪文件）");
  const branchResult = gitStatus(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.status !== 0) throw new Error("detached HEAD 不能导入或升级 Fork；请先 git switch <工作分支>");
  const branch = branchResult.stdout.trim();
  if (branch === "vendor/upstream") throw new Error("不能在 vendor/upstream 上运行升级");
  const oldVendor = git(["rev-parse", vendorRef]);
  if (gitStatus(root, ["merge-base", "--is-ancestor", oldVendor, "HEAD"]).status !== 0) {
    if (gitStatus(root, ["merge-base", oldVendor, "HEAD"]).status !== 0) throw new Error("vendor/upstream 不在当前分支的谱系上（没有共同祖先）；请切换到已合入 vendor 的工作分支");
    throw new Error("vendor/upstream 有尚未合入当前分支的原版提交；请先执行 git merge vendor/upstream，解冲突并提交完成合并，然后再升级");
  }
  const prefix = `fork/${fork}`;
  const metadataPath = `${prefix}/UPSTREAM.json`;
  let previous;
  if (existsSync(path.join(root, metadataPath))) {
    if (npm || repository || requestedSubdir || requestedRegistry || requestedTarball || requestedExclude.length) throw new Error("已有 Fork 的来源和 exclude 请在 UPSTREAM.json 中显式修改并提交，不重复传首次导入参数");
    previous = JSON.parse(readFileSync(path.join(root, metadataPath), "utf8"));
  } else {
    if (existsSync(path.join(root, prefix)) || git(["ls-tree", "--name-only", oldVendor, "--", prefix])) throw new Error("Fork 目录已存在但缺少 UPSTREAM.json；请先补齐来源记录，不能覆盖首次导入");
    if (Boolean(npm) === Boolean(repository) || npm && requestedSubdir || repository && (!requestedSubdir || requestedRegistry || requestedTarball)) throw new Error(usage);
    previous = npm ? { type: "npm", package: npm, registry: requestedRegistry, tarball: requestedTarball } : { type: "git", repository, subdirectory: requestedSubdir };
    if (requestedExclude.length) previous.exclude = requestedExclude;
  }
  if (requestedTarball && !requestedTarball.startsWith("file:")) throw new Error("--tarball 仅用于显式 file: 离线来源");
  const exclude = checkExclude(previous.exclude);
  const temp = mkdtempSync(path.join(tmpdir(), "pi-fork-upgrade-"));
  try {
    let metadata, bytes, subdirectory;
    if (previous.type === "npm") {
      const registry = previous.registry ?? "https://registry.npmjs.org/";
      if (!["https:", "file:"].includes(new URL(registry).protocol)) throw new Error("registry 来源只支持 https: 或显式 file:");
      const info = JSON.parse((await get(new URL(`${encodeURIComponent(previous.package)}/${encodeURIComponent(version)}`, registry).href)).toString());
      if (info.name !== previous.package || info.version !== version) throw new Error("registry 包名或版本不匹配");
      // 元数据不能授予本地文件读取权；离线 tarball 必须在来源记录/参数中显式指定。
      if (new URL(info.dist.tarball).protocol !== "https:") throw new Error("registry 元数据的 tarball URL 必须是 https:");
      const tarball = previous.tarball?.startsWith("file:") ? previous.tarball : info.dist.tarball;
      bytes = await get(tarball);
      verifyIntegrity(bytes, info.dist.integrity);
      metadata = { type: "npm", package: info.name, version: info.version, registry, tarball, integrity: info.dist.integrity };
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
    if (exclude.length) metadata.exclude = exclude;
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
    const records = new Map();
    // 文件规则只匹配普通文件，目录规则只匹配目录并停止递归；类型不符时拒绝，
    // 避免 "src" 排掉 src/、或 "dist/" 排掉同名普通文件。
    function excluded(local, stat) {
      for (const item of exclude) {
        if (item.endsWith("/")) {
          if (!`${local}/`.startsWith(item)) continue;
          if (!stat.isDirectory()) throw new Error(`exclude 规则 ${item} 指向目录，但上游的 ${local} 不是目录；请修正 exclude`);
          return true;
        }
        if (local !== item) continue;
        if (!stat.isFile()) throw new Error(`exclude 规则 ${item} 指向普通文件，但上游的 ${local} 不是普通文件；目录规则请写成 ${item}/`);
        return true;
      }
      return false;
    }
    function add(directory, relative = "") {
      for (const name of readdirSync(directory).sort()) {
        if ([".git", "UPSTREAM.json"].includes(name) && !relative) {
          if (name === ".git") throw new Error("上游包不能包含 .git");
          continue;
        }
        const filename = path.join(directory, name);
        const local = path.posix.join(relative, name);
        const stat = lstatSync(filename);
        if (excluded(local, stat)) continue;
        const target = path.posix.join(prefix, local);
        if (stat.isDirectory()) add(filename, local);
        else if (stat.isFile()) {
          const blob = git(["hash-object", ...(!dryRun ? ["-w"] : []), "--stdin"], readFileSync(filename));
          records.set(target, { mode: stat.mode & 0o111 ? "100755" : "100644", blob });
        } else throw new Error(`不支持的文件: ${filename}`);
      }
    }
    add(source);
    const oldRecords = new Map();
    const entries = git(["ls-tree", "-r", "-z", oldVendor, "--", prefix]);
    for (const entry of entries.split("\0").filter(Boolean)) {
      const [, mode, blob, filename] = entry.match(/^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/);
      if (filename !== metadataPath) oldRecords.set(filename, { mode, blob });
    }
    const differences = [];
    for (const filename of [...new Set([...oldRecords.keys(), ...records.keys()])].sort()) {
      const before = oldRecords.get(filename), after = records.get(filename);
      if (!before) differences.push(`A\t${filename}`);
      else if (!after) differences.push(`D\t${filename}`);
      else if (before.mode !== after.mode || before.blob !== after.blob) differences.push(`M\t${filename}`);
    }
    log(differences.join("\n") || `${fork}: 原版减去 exclude 后逐字节一致（含文件模式，不计 UPSTREAM.json 来源记录）`);
    if (dryRun) { log("dry-run：已下载、校验、展开；未写对象库、未提交、未更新分支或工作区"); return { identical: !differences.length, metadata }; }
    const indexGit = gitRunner(root, { GIT_INDEX_FILE: path.join(temp, "index") });
    indexGit(["read-tree", oldVendor]);
    const oldFiles = indexGit(["ls-files", "-z", "--", prefix]);
    if (oldFiles) indexGit(["update-index", "--force-remove", "-z", "--stdin"], oldFiles);
    const blob = git(["hash-object", "-w", "--stdin"], json(metadata));
    records.set(metadataPath, { mode: "100644", blob });
    indexGit(["update-index", "-z", "--index-info"], [...records].map(([filename, { mode, blob }]) => `${mode} ${blob}\t${filename}\0`).join(""));
    const tree = indexGit(["write-tree"]);
    // 下载期间可能有其他操作，提交前重新检查，不覆盖并发分支更新。
    if (git(["status", "--porcelain", "--untracked-files=all"]) || gitStatus(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() !== branch || git(["rev-parse", "HEAD"]) !== initialHead) throw new Error("下载期间工作区或分支改变，拒绝提交");
    const commit = git(["commit-tree", tree, "-p", oldVendor, "-m", `导入 ${fork} 上游原版 ${version}`]);
    git(["update-ref", vendorRef, commit, oldVendor]);
    // UPSTREAM.json 随 vendor merge 同时进入当前分支，不另造 main-only 修改。
    const merge = spawnSync("git", ["-c", "core.fsmonitor=false", "merge", "--no-edit", "-m", `合并 ${fork} 上游原版 ${version}`, "vendor/upstream"], { cwd: root, encoding: "utf8" });
    log(merge.stdout ?? "");
    if (merge.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"]);
      throw new Error(`合并停止，vendor 提交 ${commit} 已保留。冲突文件：\n${conflicts || "（无冲突文件，请检查 Git 错误）"}\n${merge.stderr ?? ""}\n下一步：手动解冲突，git add 后 git commit；按 LOCAL_PATCHES.md 复查并运行测试。放弃本次合并用 git merge --abort；vendor 原版仍保留。重试前先执行 git merge vendor/upstream，完成合并后再升级。`);
    }
    return { commit, metadata };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await upgrade(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
