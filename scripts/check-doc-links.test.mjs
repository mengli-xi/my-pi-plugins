import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDocs, headingAnchors, relativeLinks } from "./check-doc-links.mjs";

function forkFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-doc-workspace-"));
  const owner = "fork/upstream";
  const workspace = `${owner}/extensions/feature`;
  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  const git = (directory, ...args) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: path.join(root, directory), encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
  }).split("\0").filter(Boolean);
  put("package.json", JSON.stringify({ workspaces: ["local/*", workspace] }));
  put("README.md", `[包](${workspace}/README.md)\n[本地](local/demo/README.md)\n`);
  put("local/demo/README.md", "# 本地\n");
  put(`${workspace}/package.json`, "{}");
  put(`${workspace}/README.md`, "# 包\n[合同](docs/contract.md#中文-api)\n[补丁](../../LOCAL_PATCHES.md)\n");
  put(`${workspace}/docs/contract.md`, "# 中文 API\n");
  put(`${owner}/LOCAL_PATCHES.md`, "# 本地补丁\n");
  git("", "init", "--quiet");
  git(owner, "init", "--quiet");
  git(owner, "add", ".");
  git("", "add", "README.md", "package.json", "local");
  // gitlink 不要求 fixture 创建 commit；nested index 同样可以没有 HEAD。
  git("", "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},${owner}`);
  return { root, owner, workspace, put, git, tracked: () => git("", "ls-files", "-z") };
}

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

test("active Fork 的 gitlink 覆盖包内 tracked/current 文档，不扫描 pristine 或 inactive 包", () => {
  const { root, owner, workspace, put, tracked } = forkFixture();
  try {
    assert.ok(tracked().includes(owner));
    assert.ok(!tracked().includes(`${workspace}/README.md`));
    put(`${workspace}/docs/current.md`, "# 新合同\n[返回](../README.md)\n");
    put(`${workspace}/README.md`, "# 包\n[合同](docs/contract.md#中文-api)\n[新合同](docs/current.md)\n[补丁](../../LOCAL_PATCHES.md)\n");
    put(`${owner}/README.md`, "[上游坏链](missing.md)\n");
    put(`${owner}/docs/pristine.md`, "[上游坏链](missing.md)\n");
    put(`${owner}/extensions/inactive/README.md`, "[inactive 坏链](missing.md)\n");
    put("local/demo/untracked.md", "[本地未跟踪](missing.md)\n");
    assert.deepEqual(checkDocs(root, tracked()), []);
    put("local/demo/orphan.md", "# 本地孤儿\n");
    assert.match(checkDocs(root, [...tracked(), "local/demo/orphan.md"]).join("\n"), /local\/demo\/orphan.md: 无法从根/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("active Fork 的 Git file checkout 与未 commit 的 nested index 同样可枚举", () => {
  const { root, owner, git, tracked } = forkFixture();
  try {
    mkdirSync(path.join(root, ".git/modules"));
    git(owner, "init", "--quiet", "--separate-git-dir", path.join(root, ".git/modules/upstream"));
    assert.match(readFileSync(path.join(root, owner, ".git"), "utf8"), /^gitdir:/);
    assert.deepEqual(checkDocs(root, tracked()), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Fork 的 anchors、坏链、current 孤儿、缺失 tracked 文档与补丁可达性仍是负门禁", () => {
  const { root, owner, workspace, put, tracked } = forkFixture();
  try {
    put(`${workspace}/docs/current.md`, "[坏链](missing.md)\n[错误锚点](contract.md#旧章节)\n");
    let errors = checkDocs(root, tracked()).join("\n");
    assert.match(errors, /docs\/current.md:1: 链接目标不存在 missing.md/);
    assert.match(errors, /docs\/current.md:2: 链接锚点不存在 contract.md#旧章节/);
    assert.match(errors, /docs\/current.md: 无法从根/);
    rmSync(path.join(root, workspace, "docs/contract.md"));
    errors = checkDocs(root, tracked()).join("\n");
    assert.ok(errors.includes(`${workspace}/docs/contract.md: 已跟踪文档不存在`));
    put(`${workspace}/docs/contract.md`, "# 中文 API\n");
    put(`${workspace}/README.md`, "# 包\n[合同](docs/contract.md#中文-api)\n");
    assert.ok(checkDocs(root, tracked()).includes(`${owner}/LOCAL_PATCHES.md: 无法从根 README.md 沿链接到达`));
    put("README.md", "[本地](local/demo/README.md)\n");
    assert.ok(checkDocs(root, tracked()).includes(`${workspace}/README.md: 无法从根 README.md 沿链接到达`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Fork workspace glob 只激活匹配的包，多个包共用 owning Fork 的补丁文档", () => {
  const { root, owner, workspace, put, git, tracked } = forkFixture();
  try {
    const sibling = `${owner}/extensions/second`;
    put("package.json", JSON.stringify({ workspaces: [`${owner}/extensions/*`] }));
    put(`${sibling}/package.json`, "{}");
    put(`${sibling}/README.md`, "# 第二个包\n[补丁](../../LOCAL_PATCHES.md)\n");
    put(`${owner}/other/README.md`, "[不启用](missing.md)\n");
    git(owner, "add", ".");
    put("README.md", `[包](${workspace}/README.md)\n[第二个包](${sibling}/README.md)\n[本地](local/demo/README.md)\n`);
    assert.deepEqual(checkDocs(root, tracked()), []);
    put(`${sibling}/docs/orphan.md`, "# 新孤儿\n");
    assert.ok(checkDocs(root, tracked()).includes(`${sibling}/docs/orphan.md: 无法从根 README.md 沿链接到达`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("缺少 active Fork、package、Git checkout 或必要文档时明确失败", () => {
  const { root, owner, workspace, put, tracked } = forkFixture();
  try {
    rmSync(path.join(root, owner, "LOCAL_PATCHES.md"));
    assert.ok(checkDocs(root, tracked()).includes(`${owner}/LOCAL_PATCHES.md: 已跟踪文档不存在`));
    rmSync(path.join(root, workspace, "README.md"));
    assert.ok(checkDocs(root, tracked()).includes(`${workspace}/README.md: 已跟踪文档不存在`));
    rmSync(path.join(root, owner, ".git"), { recursive: true });
    assert.ok(checkDocs(root, tracked()).includes(`${owner}: active Fork 的 Git repository 未初始化`));
    rmSync(path.join(root, workspace, "package.json"));
    assert.ok(checkDocs(root, tracked()).includes(`${workspace}: active Fork workspace 缺少 package.json`));
    rmSync(path.join(root, owner), { recursive: true });
    assert.ok(checkDocs(root, tracked()).includes(`${workspace}: active Fork workspace 不存在`));
    put("package.json", JSON.stringify({ workspaces: ["fork/*/extensions/*"] }));
    assert.ok(checkDocs(root, tracked()).includes("fork/*/extensions/*: active Fork workspace 不存在"));
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
