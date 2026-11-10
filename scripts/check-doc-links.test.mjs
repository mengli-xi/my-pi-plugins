import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDocs, headingAnchors, relativeLinks } from "./check-doc-links.mjs";

test("解析实际相对目标，忽略代码、注释与外部 URL", () => {
  const links = relativeLinks(`
[中文](docs/说明%20书.md#章节)
[括号](docs/a(b).md "标题")
![图](image.png)
[引用][ref]
[ref]: <docs/ref.md>
<a href="docs/html.md">链接</a>
<https://example.invalid>
[远程](https://example.invalid) [邮件](mailto:fixture@example.invalid)
\`[代码](missing.md)\`
<!-- [注释](missing.md) -->
\`\`\`md
[示例](missing.md)
\`\`\`
`);
  assert.deepEqual(new Set(links.map(link => link.target)), new Set([
    "docs/说明%20书.md#章节", "docs/a(b).md", "image.png", "docs/ref.md", "docs/html.md",
  ]));
});

test("GitHub 标题 slug 保留中文、处理行内格式和重复标题，不计代码示例", () => {
  const anchors = headingAnchors(`
# 中文标题：API 与 \`Code\`
## *Hello*, [World](https://example.invalid)! <em>HTML</em>
## 中文标题：API 与 \`Code\`
## 中文标题：API 与 Code-1
## 中文标题：API 与 \`Code\`
## 😄 Emoji_É 中文
## A &amp; B &#x4E2D; &eacute; \`&amp;\`
Setext 标题
===========
> ## 引用标题
- ### 列表标题
<!--
## 注释标题
-->
\`\`\`md
## 示例标题
\`\`\`
`);
  assert.deepEqual([...anchors], [
    "中文标题api-与-code", "hello-world-html", "中文标题api-与-code-1",
    "中文标题api-与-code-1-1", "中文标题api-与-code-2", "-emoji_é-中文",
    "a--b-中-é-amp", "setext-标题", "引用标题", "列表标题",
  ]);
});

test("同页和跨文件锚点必须存在，百分号编码与查询串不绕过检查", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-doc-anchors-"));
  const put = (name, text) => writeFileSync(path.join(root, name), text);
  try {
    put("README.md", "# 根标题\n[同页](#根标题)\n[跨页](合同.md?view=1#中文-api)\n[重名](合同.md#中文-api-1)\n");
    put("合同.md", "# 中文 API\n## 中文 API\n");
    const tracked = ["README.md", "合同.md"];
    assert.deepEqual(checkDocs(root, tracked), []);
    put("README.md", "# 根标题\n[编码](%E5%90%88%E5%90%8C.md#%E4%B8%AD%E6%96%87-api)\n");
    assert.deepEqual(checkDocs(root, tracked), []);
    put("README.md", "# 根标题\n[跨页](合同.md#旧章节)\n[同页](#不存在)\n[假重名](合同.md#中文-api-2)\n[错误编码](合同.md#%FF)\n");
    assert.deepEqual(checkDocs(root, tracked), [
      "README.md:2: 链接锚点不存在 合同.md#旧章节",
      "README.md:3: 链接锚点不存在 #不存在",
      "README.md:4: 链接锚点不存在 合同.md#中文-api-2",
      "README.md:5: 无效链接编码 合同.md#%FF",
    ]);
    // 同页锚点不能让未链接的文件变成可达。
    put("README.md", "# 根标题\n[同页](#根标题)\n");
    assert.match(checkDocs(root, tracked).join("\n"), /合同.md: 无法从根/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Fork 文档统一由主仓库 ls-files 枚举，未跟踪不检查，断链和孤儿受门禁约束", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-doc-fork-"));
  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  try {
    put("README.md", "[Fork](fork/demo/README.md)\n");
    put("fork/demo/README.md", "[合同](docs/contract.md#中文-api)\n[补丁](LOCAL_PATCHES.md)\n");
    put("fork/demo/docs/contract.md", "# 中文 API\n");
    put("fork/demo/LOCAL_PATCHES.md", "# 补丁\n");
    git("init", "--quiet"); git("add", ".");
    const tracked = () => git("ls-files", "-z");
    assert.ok(tracked().includes("fork/demo/README.md"));
    assert.deepEqual(checkDocs(root, tracked()), []);
    put("fork/demo/untracked.md", "[坏链](missing.md)\n");
    assert.deepEqual(checkDocs(root, tracked()), []);
    git("add", ".");
    assert.match(checkDocs(root, tracked()).join("\n"), /untracked.md:1: 链接目标不存在/);
    assert.match(checkDocs(root, tracked()).join("\n"), /untracked.md: 无法从根/);
    rmSync(path.join(root, "fork/demo/docs/contract.md"));
    assert.match(checkDocs(root, tracked()).join("\n"), /contract.md: 已跟踪文档不存在/);
    put("fork/demo/docs/contract.md", "# 旧标题\n");
    assert.match(checkDocs(root, tracked()).join("\n"), /链接锚点不存在 docs\/contract.md#中文-api/);
    put("README.md", "# 根\n");
    assert.match(checkDocs(root, tracked()).join("\n"), /fork\/demo\/README.md: 无法从根/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("未使用的引用定义不构成可达链接", () => {
  assert.deepEqual(relativeLinks("[unused]: orphan.md\n"), []);
  assert.deepEqual(relativeLinks("[使用][ref]\n[ref]: docs/合同.md\n").map(link => link.target), ["docs/合同.md"]);
});

test("沿多层链接检查断链与孤儿；已跟踪文件集决定覆盖范围", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-doc-links-"));
  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  try {
    put("README.md", "[包](local/demo/README.md)\n[图片](local/demo/image.png)\n");
    put("local/demo/README.md", "[合同](docs/合同.md)\n");
    put("local/demo/docs/合同.md", "[返回](../README.md)\n");
    put("local/demo/image.png", "fixture");
    put("local/demo/docs/orphan.md", "孤儿");
    put("untracked.md", "未跟踪，不应扫描 [错误](missing.md)");
    const tracked = ["README.md", "local/demo/README.md", "local/demo/docs/合同.md"];
    assert.deepEqual(checkDocs(root, tracked), []);
    assert.match(checkDocs(root, [...tracked, "local/demo/docs/orphan.md"]).join("\n"), /orphan.md: 无法从根/);
    put("local/demo/docs/合同.md", "[坏链](不存在.md)\n");
    assert.match(checkDocs(root, tracked).join("\n"), /合同.md:1: 链接目标不存在/);
    put("local/demo/docs/合同.md", "[编码](%FF.md)\n");
    assert.match(checkDocs(root, tracked).join("\n"), /无效链接编码/);
    assert.deepEqual(checkDocs(root, ["README.md", "local/demo/README.md", "node_modules/x.md"]), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
