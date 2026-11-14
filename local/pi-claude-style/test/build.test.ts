import { currentBuild } from "../../../scripts/retained-build.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

// Follow only synchronous ESM edges; a dynamic import must remain outside
// this closure even when its implementation is also a build partition.
function eagerSources(entry: string, seen = new Set<string>()): string {
  if (seen.has(entry)) return "";
  seen.add(entry);
  const source = readFileSync(entry, "utf8");
  const parsed = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true);
  let result = source;
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
    assert.ok(specifier.text.endsWith(".ts"), `loader hop must stay .ts: ${specifier.text}`);
    result += eagerSources(resolve(dirname(entry), specifier.text), seen);
  }
  return result;
}

test("production build keeps overlay cold and invalidates Jiti's disk cache after rebuild", { timeout: 120_000 }, (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cc-build-"));
  const root = join(workspace, "local", "pi-claude-style");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(workspace, "scripts"));
  cpSync(resolve(packageRoot, "../../scripts/retained-build.mjs"), join(workspace, "scripts/retained-build.mjs"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const path of ["src", "scripts", "child.ts", "assets", "config.json"]) cpSync(join(packageRoot, path), join(root, path), { recursive: true });
  symlinkSync(resolve(packageRoot, "../../node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  const build = () => execFileSync(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root, stdio: "pipe" });
  const currentDist = () => currentBuild(root);
  const runner = join(root, "load.mjs");
  writeFileSync(runner, `
import { createJiti } from "jiti";
import { currentBuild } from ${JSON.stringify(new URL("../../../scripts/retained-build.mjs", import.meta.url).href)};
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import * as host from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
const jiti = createJiti(import.meta.url, {
  fsCache: ${JSON.stringify(join(root, "cache"))}, tryNative: false,
  virtualModules: { "@earendil-works/pi-coding-agent": host, "@earendil-works/pi-tui": tui },
});
const overlay = await jiti.import(pathToFileURL(join(currentBuild(${JSON.stringify(root)}), "src/overlay.ts")).href);
console.log(overlay.itemTitle({ presentation: "question", activities: [] }));
`);
  const load = () => execFileSync(process.execPath, [runner], { cwd: root, encoding: "utf8" }).trim();
  build();
  const moduleOwners = new Map<string, string>();
  for (const file of readdirSync(join(currentDist(), "src"), { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(currentDist(), "src", file), "utf8");
    const markers = new Set([...source.matchAll(/^\/\/ (src\/[^\r\n]+)$/gm)].map((match) => match[1]!));
    for (const marker of markers) {
      assert.ok(!moduleOwners.has(marker), `${marker} appears in both ${moduleOwners.get(marker)} and ${file}`);
      moduleOwners.set(marker, file);
    }
  }
  assert.ok(moduleOwners.size > 0, "the build must retain source module markers");
  const eager = eagerSources(join(currentDist(), "index.ts"));
  assert.doesNotMatch(eager, /function createToolGroupOverlayClass\(/u, "the real overlay implementation must not be on the startup graph");
  assert.match(eager, /registerTranscriptCommands/u, "startup still installs transcript commands/shortcuts");
  assert.equal(load(), "Questionnaire");
  assert.ok(readdirSync(join(root, "cache")).length > 0, "the second process must use a populated Jiti disk cache");

  const sourcePath = join(root, "src/overlay.ts");
  const source = readFileSync(sourcePath, "utf8");
  assert.equal(source.split('return "Questionnaire";').length, 2);
  writeFileSync(sourcePath, source.replace('return "Questionnaire";', 'return "Rebuilt questionnaire";'));
  build();
  assert.equal(load(), "Rebuilt questionnaire", "unchanged entry paths cannot resurrect the previous implementation");
});
