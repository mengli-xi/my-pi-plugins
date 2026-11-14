import { retainedBuild } from "../../../scripts/retained-build.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = retainedBuild(root, ["assets", "config.json"]);
const dist = pathToFileURL(`${build.output}/`);

execFileSync("bun", [
  "build", "src/config/storage.ts", "--outfile", fileURLToPath(new URL("config-storage.cjs", dist)),
  "--target", "node", "--format", "cjs",
], { cwd: root, stdio: "inherit" });

// Keep import.meta.url at dist/src depth for child descriptors/config lookup.
// Pi 1.5's public TS extension loader supplies embedded host virtual modules;
// its Jiti async ESM .js path instead uses native import, even with tryNative
// disabled (loader.js / Jiti eval_evalModule). Bun still emits JavaScript: .ts
// selects that supported loader, not a different source language or host patch.
// EVERY entry/shared/lazy chunk must keep .ts: one .js hop can bind Pi imports
// to devDependency copies. Child/diagnostic consumers must follow this contract;
// do not add .js aliases. scripts/check-internals-host.mjs rejects wrong host identities or
// a missing compact patch. The native conf writer has no Pi imports and stays CJS.
// Give splitting module-sized boundaries instead of a few giant flattened
// scopes: Jiti's TS/ESM transform repeatedly traverses those scopes. These are
// build partitions: src/*.ts top-level files automatically become build entries,
// not additional plugin entry points. Keep them at src depth
// so import.meta.url and the native config writer retain their existing base.
const partitions = readdirSync(new URL("../src/", import.meta.url))
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => `src/${name}`);
execFileSync("bun", [
  "build", ...partitions,
  "--outdir", fileURLToPath(new URL("src", dist)), "--root", "src", "--target", "node", "--format", "esm", "--splitting",
  "--entry-naming", "[dir]/[name].ts", "--chunk-naming", "chunk-[hash].ts",
  "--external", "@earendil-works/*", "--external", "typebox",
  "--external", "conf", "--external", "pi-runtime-contracts",
  "--define", 'CC_STYLE_CONFIG_STORAGE_MODULE="../config-storage.cjs"',
  "--define", 'CC_STYLE_MAIN_ENTRYPOINT="../../index.ts"',
], { cwd: root, stdio: "inherit" });
mkdirSync(dist, { recursive: true });
writeFileSync(new URL("index.ts", dist), 'export { default } from "./src/bootstrap.ts";\n');

// Child presentation remains an independently loadable presentation bundle.
execFileSync("bun", [
  "build", "child.ts", "--outfile", fileURLToPath(new URL("child.ts", dist)), "--target", "node", "--format", "esm",
  "--external", "@earendil-works/*", "--external", "pi-runtime-contracts",
  "--define", 'CC_STYLE_CONFIG_STORAGE_MODULE="./config-storage.cjs"',
], { cwd: root, stdio: "inherit" });

build.publish("index.ts", []);
