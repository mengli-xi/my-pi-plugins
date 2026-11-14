import { retainedBuild } from "../../../scripts/retained-build.mjs";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = retainedBuild(root);
const dist = build.output;

const sources = (await readdir(root))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
  .sort();

for (const source of sources) {
  const input = join(root, source);
  const output = join(dist, source.replace(/\.ts$/, ".js"));
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      input,
      "--outfile",
      output,
      "--target",
      "bun",
      "--packages",
      "external",
      "--no-bundle",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to transpile ${source} (exit ${exitCode})`);
  }

  const compiled = await readFile(output, "utf8");
  const rewritten = compiled
    .replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2")
    .replace(/(import\s*\(\s*["'][^"']+)\.ts(["'])/g, "$1.js$2")
    .replace(/(import\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
  await writeFile(output, rewritten);
}

for (const asset of [
  "app-bridge.bundle.js",
  "mcp-keyring-helper.cjs",
]) {
  await copyFile(join(root, asset), join(dist, asset));
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(dist, "package.json"), JSON.stringify({ type: "module", version: manifest.version }) + "\n");

console.log(`Built ${sources.length} JavaScript modules in dist/`);

build.publish("index.js", ["app-bridge.bundle.js"]);
