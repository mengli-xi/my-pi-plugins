import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import GithubSlugger from "github-slugger";
import { decodeHTML } from "entities";

const excluded = name => name.split("/").some(part => part === "node_modules");

// 忽略示例中的链接，但保留行数以便诊断。支持行内、引用式、图片和 HTML 链接。
export function relativeLinks(markdown) {
  let fence;
  const text = markdown.split("\n").map(line => {
    const mark = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = undefined;
      return "";
    }
    if (mark) { fence = mark[1]; return ""; }
    return line.replace(/(`+)[\s\S]*?\1/g, "");
  }).join("\n").replace(/<!--[\s\S]*?-->/g, block => block.replace(/[^\n]/g, ""));
  const found = [];
  const add = (target, index) => {
    target = target.replace(/\\([\\()\[\] ])/g, "$1").replaceAll("&amp;", "&");
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return;
    found.push({ target, line: text.slice(0, index).split("\n").length });
  };
  const refs = new Map();
  const refKey = value => value.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
    refs.set(refKey(match[1]), match[2] ?? match[3]);
  }
  // 扫描括号深度，避免把带括号的文件名或可选标题当作目标的一部分。
  for (const match of text.matchAll(/!?\[(?:\\.|[^\]\\])*\]\(/g)) {
    let index = match.index + match[0].length;
    while (/\s/.test(text[index] ?? "") && index < text.length) index++;
    let target = "";
    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      if (end < 0) continue;
      target = text.slice(index + 1, end);
    } else {
      let depth = 0;
      for (; index < text.length; index++) {
        const char = text[index];
        if (char === "\\" && index + 1 < text.length) { target += char + text[++index]; continue; }
        if (char === ")" && depth === 0 || /\s/.test(char) && depth === 0) break;
        if (char === "(") depth++;
        if (char === ")") depth--;
        target += char;
      }
    }
    add(target, match.index);
  }
  for (const match of text.matchAll(/\[([^\]]+)\](?:\[([^\]]*)\])?/g)) {
    if (text[match.index + match[0].length] === "(" || text[match.index + match[0].length] === ":") continue;
    const target = refs.get(refKey(match[2] || match[1]));
    if (target) add(target, match.index);
  }
  for (const match of text.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(match[1], match.index);
  return found;
}

// 先取渲染后的标题文字，再按 GitHub 规则生成 slug；每份文档独立处理重名后缀。
export function headingAnchors(markdown) {
  const slugger = new GithubSlugger();
  const anchors = new Set();
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type !== "heading") return;
    const html = marked.Parser.parseInline(token.tokens);
    const text = decodeHTML(html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, ""));
    anchors.add(slugger.slug(text));
  });
  return anchors;
}

function workspaceDocs(root) {
  const files = new Set();
  const errors = [];
  const manifest = path.join(root, "package.json");
  if (!existsSync(manifest)) return { files, errors };
  const { workspaces = [] } = JSON.parse(readFileSync(manifest, "utf8"));
  for (const pattern of workspaces.filter(name => name.startsWith("fork/"))) {
    const packages = globSync(pattern, { cwd: root });
    if (!packages.length) errors.push(`${pattern}: active Fork workspace 不存在`);
    for (const workspace of packages) {
      const owner = workspace.split("/").slice(0, 2).join("/");
      const directory = path.join(root, owner);
      if (!existsSync(path.join(root, workspace, "package.json"))) {
        errors.push(`${workspace}: active Fork workspace 缺少 package.json`);
        continue;
      }
      try {
        const git = args => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (!existsSync(path.join(directory, ".git")) || realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !== realpathSync(directory)) {
          errors.push(`${owner}: active Fork 的 Git repository 未初始化`);
          continue;
        }
        const relative = path.posix.relative(owner, workspace);
        const readme = path.posix.join(relative, "README.md");
        const docs = path.posix.join(relative, "docs");
        // 只纳入 active package 的文档与 Fork patch 合同；不扫描上游其余包。
        const candidates = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", readme, docs, "LOCAL_PATCHES.md"]).split("\0").filter(Boolean);
        for (const file of [readme, "LOCAL_PATCHES.md", ...candidates]) files.add(path.posix.join(owner, file));
      } catch (error) {
        errors.push(`${owner}: 无法枚举 active Fork 文档: ${error.message}`);
      }
    }
  }
  return { files, errors };
}

export function checkDocs(root, tracked) {
  const workspace = workspaceDocs(root);
  const files = [...new Set([...tracked, ...workspace.files])].filter(file => file.endsWith(".md") && !excluded(file));
  const graph = new Map();
  const errors = [...workspace.errors];
  const anchorsByFile = new Map();
  for (const file of files) {
    const absolute = path.resolve(root, file);
    if (!existsSync(absolute)) { errors.push(`${file}: 已跟踪文档不存在`); continue; }
    const edges = [];
    for (const { target, line } of relativeLinks(readFileSync(absolute, "utf8"))) {
      let pathname, anchor;
      try {
        const hash = target.indexOf("#");
        pathname = decodeURIComponent((hash < 0 ? target : target.slice(0, hash)).split("?", 1)[0]);
        anchor = hash < 0 ? "" : decodeURIComponent(target.slice(hash + 1));
      } catch { errors.push(`${file}:${line}: 无效链接编码 ${target}`); continue; }
      const destination = pathname ? path.resolve(path.dirname(absolute), pathname) : absolute;
      const relative = path.relative(root, destination).split(path.sep).join("/");
      if (excluded(relative)) continue;
      if (!existsSync(destination)) errors.push(`${file}:${line}: 链接目标不存在 ${target}`);
      else if (anchor && destination.endsWith(".md")) {
        if (!anchorsByFile.has(destination)) anchorsByFile.set(destination, headingAnchors(readFileSync(destination, "utf8")));
        if (!anchorsByFile.get(destination).has(anchor)) errors.push(`${file}:${line}: 链接锚点不存在 ${target}`);
      }
      edges.push(relative);
    }
    graph.set(file, edges);
  }
  const reachable = new Set();
  const pending = ["README.md"];
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    pending.push(...(graph.get(file) ?? []));
  }
  for (const file of files) {
    if (!["README.md", "CONTRIBUTING.md", "AGENTS.md"].includes(file) && !reachable.has(file)) errors.push(`${file}: 无法从根 README.md 沿链接到达`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const tracked = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const errors = checkDocs(root, tracked);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("文档链接与可达性检查通过");
}
