import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { offlineGuard, sourceResolver, testSandbox } from "./scripts/test-env.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));

function run(args, options) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

const imports = `
  import assert from "node:assert/strict";
  const manifest = ${JSON.stringify(manifest)};
  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
    const entry = await import(specifier);
    assert.ok(Object.keys(entry).length > 0, specifier);
  }
  const { default: extension, createMcpAdapter } = await import("pi-mcp-adapter");
  const { createHostManagedMcpAdapter } = await import("pi-mcp-adapter/host-managed");
  const { getMcpOAuthTokensForUrl, inspectMcpOAuthTokensForUrl, updateMcpOAuthTokensForUrl } = await import("pi-mcp-adapter/oauth");
  const { getPiGlobalConfigPath } = await import("pi-mcp-adapter/config");
  const { getMetadataCachePath } = await import("pi-mcp-adapter/metadata-cache");
  for (const value of [extension, createMcpAdapter, createHostManagedMcpAdapter,
    getMcpOAuthTokensForUrl, inspectMcpOAuthTokensForUrl, updateMcpOAuthTokensForUrl]) assert.equal(typeof value, "function");
  assert.equal(getPiGlobalConfigPath(), process.env.PI_CODING_AGENT_DIR + "/mcp-adapter.json");
  assert.equal(getMetadataCachePath(), process.env.PI_CODING_AGENT_DIR + "/mcp-cache.json");
`;

test("every public export resolves to its advertised source or compiled runtime and type entry", async () => {
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
    assert.equal(import.meta.resolve(specifier), new URL(entry.import, import.meta.url).href);
    await access(new URL(entry.import, import.meta.url));
    await access(new URL(entry.types, import.meta.url));
  }
});

test("compiled types export the shared runtime helpers and Apps schemas", async () => {
  const types = await import("pi-mcp-adapter/types");
  const runtime = await import("./dist/runtime-types.js");
  const streams = await import("./dist/ui-stream-types.js");
  for (const [name, value] of Object.entries(runtime)) assert.equal(types[name], value, name);
  assert.equal(types.uiStreamModeSchema, streams.uiStreamModeSchema);
  assert.equal(types.uiStreamModeSchema.safeParse("stream-first").success, true);
  assert.equal(types.uiStreamModeSchema.safeParse("invalid-mode").success, false);
});

test("all public entries import together in a fresh isolated process", () => {
  const sandbox = testSandbox("pi-mcp-public-exports-");
  try {
    run(["--import", sourceResolver, "--import", offlineGuard, "--import", "tsx", "--input-type=module", "-e", imports], { cwd: packageRoot, env: sandbox.env });
  } finally { sandbox.cleanup(); }
});

test("npm pack includes working runtime and declaration entries for every public export", async () => {
  const sandbox = testSandbox("pi-mcp-pack-");
  try {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", sandbox.root], {
      cwd: packageRoot, encoding: "utf8", timeout: 30_000,
      env: { ...sandbox.env, npm_config_cache: join(sandbox.root, "cache"), npm_config_offline: "true" },
      shell: process.platform === "win32",
    });
    assert.ifError(packed.error);
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const [pack] = JSON.parse(packed.stdout);
    const files = new Set(pack.files.map(file => file.path));
    for (const entry of Object.values(manifest.exports)) {
      for (const path of [entry.import, entry.types]) assert.ok(files.has(path.slice(2)), `not packed: ${path}`);
    }
    for (const asset of ["dist/app-bridge.bundle.js", "dist/mcp-keyring-helper.cjs", "cli.js"]) assert.ok(files.has(asset), asset);
    assert.equal([...files].some(path => path.endsWith(".test.ts") || path === "bun.lock"), false);
    const consumer = join(sandbox.root, "consumer");
    const unpacked = join(consumer, "node_modules", manifest.name);
    await mkdir(unpacked, { recursive: true });
    const extraction = spawnSync("tar", ["-xzf", join(sandbox.root, pack.filename), "--strip-components=1", "-C", unpacked], { encoding: "utf8" });
    assert.ifError(extraction.error);
    assert.equal(extraction.status, 0, extraction.stderr);
    const dependencies = join(unpacked, "node_modules");
    await mkdir(dependencies);
    // npm can place just one version-conflicting package in the nearest
    // node_modules; resolve every declared dependency through the full chain.
    for (const name of new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies), "@types/node", "@types/cross-spawn", "@types/open"])) {
      let dependencyRoot = packageRoot;
      while (!existsSync(join(dependencyRoot, "node_modules", name, "package.json"))) {
        const parent = dirname(dependencyRoot);
        assert.notEqual(parent, dependencyRoot, `missing installed dependency: ${name}`);
        dependencyRoot = parent;
      }
      const destination = join(dependencies, name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(await realpath(join(dependencyRoot, "node_modules", name)), destination, "dir");
    }
    run(["--import", sourceResolver, "--import", offlineGuard, "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", imports], { cwd: consumer, env: sandbox.env });
    const help = run(["--import", sourceResolver, "--import", offlineGuard, join(unpacked, "cli.js"), "--help"], { cwd: consumer, env: sandbox.env });
    assert.match(help.stdout, /pi-mcp-adapter/);
    // Resolve every advertised type entry as a real consumer, including the upstream source entries.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');
    const typeImports = Object.keys(manifest.exports).map((subpath, index) => {
      const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
      return `import * as entry${index} from ${JSON.stringify(specifier)}; void entry${index};`;
    }).join("\n");
    await writeFile(join(consumer, "consumer.ts"), typeImports);
    const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
    run([tsc, "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "--allowImportingTsExtensions", "consumer.ts"], { cwd: consumer, env: sandbox.env });
  } finally { sandbox.cleanup(); }
});
