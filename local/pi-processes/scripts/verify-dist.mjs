import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const name of ["index.js", "child.js", "child-factory.js", "manager-view.js", "supervisor.js", "matcher-worker.js"]) {
  const path = join(root, "dist", name);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`missing dist/${name}`);
  const source = await readFile(path, "utf8");
  if (/\/(?:Users|home)\/[^/\s"'\\]+\//u.test(source)) throw new Error(`absolute developer path in dist/${name}`);
}
const main = await readFile(join(root, "dist", "index.js"), "utf8");
if (!main.includes('import(new URL("./manager-view.js", import.meta.url).href)')) throw new Error("management view must remain a first-use file import");
for (const name of ["index.js", "child.js"]) {
  const source = await readFile(join(root, "dist", name), "utf8");
  if (source.includes("pi-li-uikit/process-panel") || source.includes("pi-li-uikit/editor-overlay") || source.includes("class ProcessManagerEditor")) throw new Error(`management UI eagerly imported by ${name}`);
}
const supervisor = await readFile(join(root, "dist/supervisor.js"), "utf8");
const worker = await readFile(join(root, "dist/matcher-worker.js"), "utf8");
for (const [name, source] of [["supervisor", supervisor], ["matcher-worker", worker]]) {
  for (const forbidden of ["pi-coding-agent", "pi-tui", "pi-runtime-contracts"]) {
    if (source.includes(forbidden)) throw new Error(`${name} imports forbidden ${forbidden}`);
  }
}
console.log("dist verified");
