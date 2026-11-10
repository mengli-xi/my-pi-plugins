import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../fork/pi-goal/scripts/check-extension-boundaries.mjs", import.meta.url));

test("Goal 单包边界仍检查入口、扩展依赖与源码 import，并按 metadata 接受共享库", t => {
  const root = mkdtempSync(path.join(tmpdir(), "goal-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  const manifest = { name: "@narumitw/pi-goal", pi: { extensions: ["./dist/index.js"] }, scripts: { build: "bun build src/index.ts" } };
  const save = () => put("package.json", JSON.stringify(manifest));
  save(); put("src/index.ts", "export default () => {};\n");
  const run = () => spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.match(run().stdout, /pi-goal 单包边界检查通过/);
  manifest.dependencies = { "@narumitw/pi-other": "*" }; save();
  assert.match(run().stderr, /dependencies must not reference @narumitw\/pi-other/);
  delete manifest.dependencies; save();
  put("src/index.ts", "import '@narumitw/pi-other';\nexport default () => {};\n");
  assert.match(run().stderr, /must not import @narumitw\/pi-other/);
  const library = { name: "@narumitw/pi-other", scripts: { build: "build" }, files: ["dist"], main: "./dist/index.js", types: "./dist/index.d.ts" };
  put("node_modules/@narumitw/pi-other/package.json", JSON.stringify(library));
  assert.equal(run().status, 0);
  library.pi = { extensions: ["./dist/index.js"] };
  put("node_modules/@narumitw/pi-other/package.json", JSON.stringify(library));
  assert.match(run().stderr, /libraries must not declare pi.extensions/);
  put("src/index.ts", "export default () => {};\n");
  manifest.pi.extensions = ["./wrong.ts"]; save();
  assert.match(run().stderr, /pi.extensions must be/);
});
