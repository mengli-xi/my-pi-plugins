import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { once } from "node:events";
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
    if (mcp) {
      put("app-bridge.bundle.js", worker); put("mcp-keyring-helper.cjs", worker);
      for (const name of ["types", "config", "metadata-cache"]) put(`${name}.ts`, "export const value = 1;");
      put("tsconfig.public.json", JSON.stringify({ compilerOptions: { declaration: true, emitDeclarationOnly: true, allowImportingTsExtensions: true, target: "es2022", module: "esnext", moduleResolution: "bundler", types: ["node"], skipLibCheck: true }, include: ["*.ts"], exclude: ["scripts", "dist"] }));
    }
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
  writeFileSync(driver, `import { createInterface } from "node:readline";\nconst { default: old } = await import(${JSON.stringify(pathToFileURL(join(root, "dist", entry)).href)});\nimport assert from "node:assert/strict";\nimport { validateChildCapabilityManifestV1, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";\nconst capability = old.capability?.();\ncapability?.bind({ mode: "rpc", sessionManager: { getSessionId: () => "fixture" } });\nconst manifest = getOrCreateChildCapabilityRegistryV1().snapshot("fixture").registrations[0]?.manifest;\nif (manifest) assert.equal(manifest.main_entrypoint.canonical_path, ${JSON.stringify(realpathSync(publicEntry))});\nconsole.log("loaded");\nfor await (const line of createInterface({ input: process.stdin })) {\n const lazy = await old.lazy();\n if (manifest) validateChildCapabilityManifestV1(manifest);\n console.log(JSON.stringify({ version: old.version, lazy: lazy.version, child: old.child?.(), writer: old.writer?.() }));\n break;\n}\n`);
  // The child pauses after importing the old entry; the test rebuilds while it
  // waits. A fresh process separately imports the unchanged public entry path.
  return (async () => {
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
    assert.ok(existsSync(first), "previous build must remain on disk");
    childProcess.stdin.end("load\n");
    assert.deepEqual(await closed, [0, null], stderr);
    if (cc || processes) {
      assert.equal(readFileSync(publicEntry, "utf8"), mainBefore, "capability Main proof bytes must remain stable");
      assert.equal(statSync(publicEntry).ino, inodeBefore, "capability Main proof inode must remain stable");
    }
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
    assert.deepEqual(readdirSync(join(root, "dist")).filter(name => !name.startsWith(".build-")),
      mcp ? [".current.json", "config.d.ts", "config.js", "index.js", "metadata-cache.d.ts", "metadata-cache.js", "types.d.ts", "types.js"] : [".current.json", entry]);
    assert.equal(existsSync(first), false, "build beyond retention must be deleted");
    assert.ok(existsSync(second));
    assert.equal(readdirSync(join(root, "dist")).filter(name => name.startsWith(".build-")).length, 2);
    if (subagents) assert.equal(readFileSync(join(dirname(second), "skills/subagents/SKILL.md"), "utf8"), "2.0.0");
  })();
});

test("build mutex rejects a competitor, survives interruption and reclaims stale locks/corrupt pointers", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-build-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = `import { retainedBuild } from ${JSON.stringify(new URL("./retained-build.mjs", import.meta.url).href)};
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const build = retainedBuild(process.argv[1]);
writeFileSync(build.output + "/index.js", "export default " + process.argv[2] + ";");
console.log("ready");
for await (const line of createInterface({ input: process.stdin })) { build.publish(); break; }
`;
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const args = version => ["--input-type=module", "-e", script, root, String(version)];
  const build = version => execFileSync(process.execPath, args(version), { input: "publish\n", encoding: "utf8", stdio: "pipe" });
  const pause = async version => {
    const child = spawn(process.execPath, args(version), { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => child.kill("SIGKILL"));
    const closed = once(child, "close");
    const ready = once(child.stdout, "data");
    await Promise.race([ready, closed.then(result => { throw new Error(`builder exited: ${result}`); })]);
    return { child, closed };
  };
  build(0);
  const first = await pause(1);
  assert.throws(() => build(2), /Build already running.*not a build, delete .*dist\/\.lock and retry/s);
  first.child.stdin.end("publish\n");
  assert.deepEqual(await first.closed, [0, null]);
  const entry = join(root, "dist/index.js"), pointer = join(root, "dist/.current.json");
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).default)`], { encoding: "utf8" }).trim(), "1");
  const before = [readFileSync(entry, "utf8"), readFileSync(pointer, "utf8")];
  const interrupted = await pause(3);
  interrupted.child.kill("SIGTERM");
  assert.deepEqual(await interrupted.closed, [143, null]);
  assert.deepEqual([readFileSync(entry, "utf8"), readFileSync(pointer, "utf8")], before);
  assert.equal(existsSync(join(root, "dist/.lock")), false);
  const crashed = await pause(4);
  crashed.child.kill("SIGKILL");
  await crashed.closed;
  assert.ok(existsSync(join(root, "dist/.lock")));
  // Pending lock dirs left by a SIGKILL between mkdtemp and rename.
  const pending = (name, pid) => { mkdirSync(join(root, "dist", name)); if (pid) writeFileSync(join(root, "dist", name, String(pid)), ""); };
  pending(".lock-dead", spawnSync(process.execPath, ["-e", ""]).pid); pending(".lock-live", process.pid); pending(".lock-fresh"); pending(".lock-old");
  utimesSync(join(root, "dist/.lock-old"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  build(5);
  assert.deepEqual(readdirSync(join(root, "dist")).filter(name => name.startsWith(".lock-")).sort(), [".lock-fresh", ".lock-live"]);
  // PID 1 exists but belongs to another user: EPERM means a live holder.
  if (process.getuid?.() !== 0) {
    mkdirSync(join(root, "dist/.lock")); writeFileSync(join(root, "dist/.lock/1"), "");
    assert.throws(() => build(5), /Build already running \(pid 1\)/);
    rmSync(join(root, "dist/.lock"), { recursive: true });
  }
  for (const corrupt of ["{", "null"]) { writeFileSync(pointer, corrupt); build(6); }
  assert.ok(existsSync(join(currentBuild(root), "index.js")));
  assert.equal(existsSync(join(root, "dist/.lock")), false);
});
