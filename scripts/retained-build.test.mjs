import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { currentBuild } from "./retained-build.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const packages = ["local/pi-claude-style", "local/pi-processes", "local/pi-subagents", "fork/pi-mcp-adapter"];

// Run the production build scripts against tiny offline inputs. No substitute
// builder: changing a package back to its destructive build must break this test.
for (const pkg of packages) test(`${pkg}: old lazy/child files survive rebuild, fresh entry advances, retention is bounded`, t => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-retained-build-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, pkg);
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  mkdirSync(join(temporary, "scripts"), { recursive: true });
  cpSync(join(repo, "scripts/retained-build.mjs"), join(temporary, "scripts/retained-build.mjs"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(repo, pkg, "scripts/build.mjs"), join(root, "scripts/build.mjs"));
  symlinkSync(join(repo, "node_modules"), join(temporary, "node_modules"), "dir");
  const cc = pkg.endsWith("pi-claude-style"), processes = pkg.endsWith("pi-processes");
  const subagents = pkg.endsWith("pi-subagents"), mcp = pkg.endsWith("pi-mcp-adapter");
  const entry = cc ? "index.ts" : "index.js";
  const lazy = cc ? "./lazy/late.ts" : processes ? "./manager-view.js" : subagents ? "./late.js" : "./late.ts";
  const child = cc ? "../child.ts" : processes ? "./supervisor.js" : "./worker.js";
  if (cc || processes) cpSync(join(repo, pkg, "src", cc ? "child-capability.ts" : "subagent-capability.ts"), join(root, "capability-source.ts"));
  put("tsconfig.build.json", JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", rootDir: "src", outDir: "dist", types: ["node"], skipLibCheck: true }, include: ["src/**/*.ts"] }));
  put("package.json", JSON.stringify({ name: pkg.split("/")[1], type: "module", version: "0.0.0" }));
  function inputs(version) {
    if (cc || processes) put(`src/${cc ? "child-capability.ts" : "subagent-capability.ts"}`, readFileSync(join(root, "capability-source.ts"), "utf8"));
    const main = (cc || processes ? `import { ${cc ? "installClaudeStyleChildCapability" : "installProcessChildCapability"} as installCapability } from "./${cc ? "child-capability.ts" : "subagent-capability.js"}";\n` : "") + `import { execFileSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";\n` +
      (cc ? `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n` : "") +
      `export default { version: ${JSON.stringify(version)}, lazy: () => import(${processes ? `new URL(${JSON.stringify(lazy)}, import.meta.url).href` : JSON.stringify(lazy)}),` +
      ` child: () => execFileSync(process.execPath, [fileURLToPath(new URL(${JSON.stringify(child)}, import.meta.url))], { encoding: "utf8" }).trim(),` +
      (cc ? ` writer: () => require("../config-storage.cjs").version,` : "") +
      (cc || processes ? ` capability: () => installCapability(${cc ? 'fileURLToPath(new URL("../", import.meta.url))' : 'fileURLToPath(new URL("./", import.meta.url))'}),` : "") + ` };\n`;
    put(mcp ? "index.ts" : cc ? "src/bootstrap.ts" : "src/index.ts", main);
    put(cc ? "src/lazy/late.ts" : processes ? "src/ui/manager-view.ts" : mcp ? "late.ts" : "src/late.ts", `export const version = ${JSON.stringify(version)};\n`);
    const worker = `console.log(${JSON.stringify(version)});\n`;
    if (cc) { put("child.ts", worker); put("src/config/storage.ts", `export const version = ${JSON.stringify(version)};\n`); put("assets/statusline.mjs", worker); put("config.json", "{}"); }
    if (subagents) { put("skills/subagents/SKILL.md", version); for (const name of ["schemas", "validate"]) put(`src/tools/${name}.ts`, "export {};\n"); }
    if (processes) {
      put("src/child.ts", "export {};\n"); put("src/child-factory.ts", "export {};\n");
      put("src/supervisor/supervisor-entry.ts", `import { execFileSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";\nconsole.log(execFileSync(process.execPath, [fileURLToPath(new URL("./matcher-worker.js", import.meta.url))], { encoding: "utf8" }).trim());\n`);
      put("src/matchers/matcher-worker-entry.ts", worker);
    } else if (!cc) put(mcp ? "worker.ts" : "src/worker.ts", worker);
    if (mcp) { put("app-bridge.bundle.js", worker); put("mcp-keyring-helper.cjs", worker); }
  }
  function build() {
    execFileSync(mcp ? "bun" : process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "pipe", timeout: 60_000 });
    return currentBuild(root);
  }
  inputs("1.0.0");
  const first = build();
  const publicEntry = join(root, "dist", entry);
  const mainBefore = readFileSync(publicEntry, "utf8");
  const inodeBefore = statSync(publicEntry).ino;
  // Keep the old module alive across the build, but don't touch its cold paths.
  const driver = join(root, "driver.mjs");
  writeFileSync(driver, `import { createInterface } from "node:readline";\nconst { default: old } = await import(${JSON.stringify(pathToFileURL(join(root, "dist", entry)).href)});\nimport assert from "node:assert/strict";\nimport { validateChildCapabilityManifestV1, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";\nconst capability = old.capability?.();\ncapability?.bind({ mode: "rpc", sessionManager: { getSessionId: () => "fixture" } });\nconst manifest = getOrCreateChildCapabilityRegistryV1().snapshot("fixture").registrations[0]?.manifest;\nif (manifest) assert.equal(manifest.main_entrypoint.canonical_path, ${JSON.stringify(realpathSync(publicEntry))});\nconsole.log("loaded");\nfor await (const line of createInterface({ input: process.stdin })) {\n if (manifest) validateChildCapabilityManifestV1(manifest);\n const lazy = await old.lazy();\n console.log(JSON.stringify({ version: old.version, lazy: lazy.version, child: old.child?.(), writer: old.writer?.() }));\n break;\n}\n`);
  // The child pauses after importing the old entry; the test rebuilds while it
  // waits. A fresh process separately imports the unchanged public entry path.
  return (async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const childProcess = spawn(process.execPath, [driver], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => childProcess.kill("SIGKILL"));
    let stdout = "", stderr = "";
    childProcess.stdout.on("data", data => { stdout += data; });
    childProcess.stderr.on("data", data => { stderr += data; });
    const closed = once(childProcess, "close");
    await Promise.race([once(childProcess.stdout, "data"), closed.then(() => { throw new Error(stderr); })]);
    assert.equal(stdout, "loaded\n");
    inputs("2.0.0");
    const second = build();
    if (cc || processes) {
      assert.equal(readFileSync(publicEntry, "utf8"), mainBefore, "capability Main proof bytes must remain stable");
      assert.equal(statSync(publicEntry).ino, inodeBefore, "capability Main proof inode must remain stable");
    }
    assert.ok(existsSync(first), "previous build must remain on disk");
    childProcess.stdin.end("load\n");
    assert.deepEqual(await closed, [0, null], stderr);
    const old = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(old.version, "1.0.0"); assert.equal(old.lazy, "1.0.0");
    assert.equal(old.child, "1.0.0");
    if (cc) assert.equal(old.writer, "1.0.0");
    const fresh = execFileSync(process.execPath, ["--input-type=module", "-e", `const {default: value} = await import(${JSON.stringify(pathToFileURL(join(root, "dist", entry)).href)}); console.log(value.version, (await value.lazy()).version);`], { encoding: "utf8" });
    assert.equal(fresh.trim(), "2.0.0 2.0.0");
    const published = readFileSync(join(root, "dist/.current.json"), "utf8");
    put(mcp ? "index.ts" : cc ? "src/bootstrap.ts" : "src/index.ts", "export default ???;");
    assert.throws(build, "failed compilation must not publish or prune a working version");
    assert.equal(readFileSync(join(root, "dist/.current.json"), "utf8"), published);
    assert.ok(existsSync(first));
    put("dist/.build-abandoned/dist/partial", "incomplete");
    inputs("3.0.0"); build();
    assert.equal(existsSync(first), false, "build beyond retention must be deleted");
    assert.ok(existsSync(second));
    assert.equal(readdirSync(join(root, "dist")).filter(name => name.startsWith(".build-")).length, 2);
    if (subagents) assert.equal(readFileSync(join(dirname(second), "skills/subagents/SKILL.md"), "utf8"), "2.0.0");
  })();
});
