import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });

execFileSync("bun", [
  "build", "src/config/storage.ts", "--outfile", "dist/config-storage.cjs",
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
execFileSync("bun", [
  "build", "src/bootstrap.ts", "src/internals.ts", "src/probes.ts",
  "--outdir", "dist/src", "--root", "src", "--target", "node", "--format", "esm", "--splitting",
  "--entry-naming", "[dir]/[name].ts", "--chunk-naming", "[name]-[hash].ts",
  "--external", "@earendil-works/*", "--external", "typebox",
  "--external", "conf", "--external", "pi-runtime-contracts",
  "--define", 'CC_STYLE_CONFIG_STORAGE_MODULE="../config-storage.cjs"',
], { cwd: root, stdio: "inherit" });
mkdirSync(dist, { recursive: true });
writeFileSync(new URL("index.ts", dist), 'export { default } from "./src/bootstrap.ts";\n');

// Child presentation remains an independently loadable presentation bundle.
execFileSync("bun", [
  "build", "child.ts", "--outfile", "dist/child.ts", "--target", "node", "--format", "esm",
  "--external", "@earendil-works/*", "--external", "pi-runtime-contracts",
  "--define", 'CC_STYLE_CONFIG_STORAGE_MODULE="./config-storage.cjs"',
], { cwd: root, stdio: "inherit" });
