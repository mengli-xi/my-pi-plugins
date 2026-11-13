import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkEnvironment } from "./pi-checks.mjs";

export function binarySource(version, platform = process.platform, arch = process.arch) {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error(`官方二进制不支持：${platform}/${arch}`);
  const asset = `pi-${platform}-${arch}.tar.gz`;
  const base = `https://github.com/earendil-works/pi/releases/download/v${version}`;
  return { asset, url: `${base}/${asset}`, sumsUrl: `${base}/SHA256SUMS` };
}

export function checksumFor(sums, asset) {
  const matches = sums.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = /^([a-fA-F0-9]{64}) [ *](\S+)$/.exec(line);
    if (!match) throw new Error(`无效 SHA256SUMS 行：${line}`);
    return { sha256: match[1].toLowerCase(), name: match[2] };
  }).filter(entry => entry.name === asset);
  if (matches.length !== 1) throw new Error(`SHA256SUMS 必须唯一包含 ${asset}`);
  return matches[0].sha256;
}

// README 类型列决定生产范围；反查所有 extension 包，格式漂移或漏项必须报错。
export function productionPlugins(packages, readme) {
  const rows = [...readme.matchAll(/^\s*\|\s*\[[^\]]+\]\(([^)]+)\/README\.md\)\s*\|\s*([^|\r\n]+)\|/gm)]
    .map(([, directory, type]) => ({ directory, type: type.trim().replace(/\s+/g, " ") }));
  const types = new Map(rows.map(row => [row.directory, row.type]));
  for (const pkg of packages.filter(pkg => pkg.pi?.extensions?.length)) {
    if (!["插件", "Fork 插件", "开发插件", "示例插件"].includes(types.get(pkg.directory))) {
      throw new Error(`extension 包未在 README 标为生产、开发或示例插件：${pkg.directory}`);
    }
  }
  const directories = rows.filter(row => ["插件", "Fork 插件"].includes(row.type)).map(row => row.directory);
  if (!directories.length) throw new Error("README 缺少生产插件索引");
  return directories.map(directory => {
    const pkg = packages.find(pkg => pkg.directory === directory);
    if (!pkg?.pi?.extensions?.length) throw new Error(`生产插件没有 pi.extensions：${directory}`);
    return pkg;
  });
}

export async function downloadBinary(version, directory) {
  const source = binarySource(version);
  await mkdir(directory, { recursive: true });
  // curl 对 HTTPS 不回退 HTTP_PROXY；显式沿用已有代理，不写入报告。
  const env = { ...process.env, https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY };
  for (const [url, file] of [[source.url, source.asset], [source.sumsUrl, "SHA256SUMS"]]) {
    execFileSync("curl", ["--proto", "=https", "--proto-redir", "=https", "--fail", "--location", "--silent", "--show-error", "--connect-timeout", "30", "--max-time", "180", "--output", join(directory, file), url], { env, stdio: "inherit", timeout: 190_000 });
  }
  const expected = checksumFor(await readFile(join(directory, "SHA256SUMS"), "utf8"), source.asset);
  const sha256 = createHash("sha256").update(await readFile(join(directory, source.asset))).digest("hex");
  if (sha256 !== expected) throw new Error(`SHA256 不匹配：expected=${expected} actual=${sha256}`);
  console.log(`SHA256 OK ${sha256}`);
  const extracted = join(directory, "extracted");
  await mkdir(extracted);
  execFileSync("tar", ["-xzf", join(directory, source.asset), "-C", extracted], { stdio: "inherit", timeout: 60_000 });
  const candidates = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(path, entry.name));
      else if (entry.isFile() && entry.name === "pi") candidates.push(join(path, entry.name));
    }
  }
  await visit(extracted);
  if (candidates.length !== 1) throw new Error(`归档中必须有唯一 pi：${candidates.length}`);
  const binary = candidates[0];
  const versionRoot = join(directory, "version-environment");
  for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) await mkdir(join(versionRoot, name), { recursive: true });
  const actual = execFileSync(binary, ["--version"], { cwd: versionRoot, env: checkEnvironment(versionRoot), encoding: "utf8", timeout: 120_000 }).trim();
  if (actual !== version) throw new Error(`官方二进制版本 ${actual} != ${version}`);
  const metadata = { ...source, sha256, version: actual, binary };
  await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata));
  console.log(`官方二进制 ${actual}：${source.url}`);
  return metadata;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await downloadBinary(process.argv[2], resolve(process.argv[3]));
}
