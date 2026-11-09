import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const require = createRequire(import.meta.url);
const tsc = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
const bun = process.env.BUN || "bun";
// Inline the tiny shared fork grammar into the two existing cold modules. This keeps
// one source of truth without adding a TypeScript library import to Main's first frame.
for (const name of ["schemas", "validate"]) {
  const result = spawnSync(bun, ["build", `src/tools/${name}.ts`, "--outfile", `dist/tools/${name}.js`, "--target", "bun", "--external", "typebox"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Built lazy per-file SDK modules and shared fork grammar.");
