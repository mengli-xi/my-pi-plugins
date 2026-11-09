import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDocs, relativeLinks } from "./check-doc-links.mjs";

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
