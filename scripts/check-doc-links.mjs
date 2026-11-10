import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

export function checkDocs(root, tracked) {
  const files = [...new Set(tracked)].filter(file => file.endsWith(".md") && !excluded(file));
  const graph = new Map();
  const errors = [];
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
