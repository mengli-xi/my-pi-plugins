import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))); const dist = join(root, "dist");
async function files(directory) { const result = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile() && entry.name.endsWith(".js")) result.push(path); } return result; }
const paths = (await files(dist)).sort();
const sources = new Map();
const developerPath = /(?:\/(?:Users|home)\/[^/"'\s]+\/|(?:[A-Za-z]:)?\\+Users\\+[^\\\s"']+\\+)/u;
// These audited modules contain legacy .ts descriptor paths, not source imports.
const factoryDescriptorModules = new Set(["runtime/factory-catalog.js", "capabilities/sdk-provider.js", "capabilities/execution-factory.js"]);
for (const required of ["index.js", "runtime/sdk-controller.js"]) if (!paths.some((path) => relative(dist, path) === required)) throw new Error(`missing dist/${required}`);
for (const path of paths) { const name = relative(dist, path); const info = await stat(path); if (!info.isFile() || info.size === 0) throw new Error(`empty dist/${name}`); const source = await readFile(path, "utf8"); sources.set(path, source); if (developerPath.test(source)) throw new Error(`absolute developer path in dist/${name}`); if (!factoryDescriptorModules.has(name) && (source.includes('.ts"') || source.includes(".ts'"))) throw new Error(`source TypeScript import in dist/${name}`); }
const index = await stat(join(dist, "index.js")); if (index.size > 65_536) throw new Error(`dist/index.js exceeds per-file loader budget: ${index.size}`);
const entry = sources.get(join(dist, "index.js"));
for (const deferred of ["./host/process-service.js", "./ui/manager.js", "./context/effective.js"]) {
  if (!entry.includes(`import("${deferred}")`)) throw new Error(`dist/index.js lost first-use import: ${deferred}`);
}
const visited = new Set();
async function inspectStartupGraph(path) {
  if (visited.has(path)) return;
  visited.add(path);
  const name = relative(dist, path);
  if (["host/process-service.js", "ui/manager.js", "persistence/store.js", "context/capture.js", "context/effective.js", "context/prepare.js", "runtime/sdk-controller.js", "runtime/child-session.js"].includes(name)) throw new Error(`eager Main startup imported ${name}`);
  const source = sources.get(path);
  if (source === undefined) throw new Error(`startup import is outside the verified output: ${name}`);
  if (/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']pi-session-runtime\//u.test(source)) throw new Error(`eager Main startup imported shared session runtime in ${name}`);
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/gu)) {
    await inspectStartupGraph(join(dirname(path), match[1]));
  }
}
await inspectStartupGraph(join(dist, "index.js"));
for (const path of paths) {
  const name = relative(dist, path);
  if (name === "child.js" || name === "supervisor.js" || name.startsWith("supervisor/") || name === "host/runtime-controller.js" || name === "ui/terminal-handoff.js") throw new Error(`obsolete OS backend in dist/${name}`);
}
console.log(`dist verified (${paths.length} JavaScript files)`);
