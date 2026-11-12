import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
export function extensionArguments(argv: readonly string[]): string[] {
  return argv.flatMap((arg, i) => arg === "-e" || arg === "--extension" ? [argv[i + 1] ?? ""] :
    arg.startsWith("--extension=") ? [arg.slice("--extension=".length)] : []);
}
/** Sources are explicit settings.packages / CLI package roots only. A file,
 * missing manifest or unresolved selector is 'local', never its parent project. */
export async function resolvePackageNames(sources: readonly string[], cwd: string): Promise<string[]> {
  const names = new Set<string>();
  const require = createRequire(join(resolve(cwd), "package.json"));
  for (const source of new Set(sources)) {
    let manifestPath: string;
    if (source.startsWith("npm:")) {
      const match = source.slice(4).match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/);
      if (!match) { names.add("local"); continue; }
      try { manifestPath = require.resolve(`${match[1]}/package.json`); } catch { names.add("local"); continue; }
    } else {
      if (!source || (/^[a-z]+:/i.test(source) && !isAbsolute(source))) { names.add("local"); continue; }
      const root = resolve(cwd, source);
      try { if (!(await stat(root)).isDirectory()) { names.add("local"); continue; } } catch { names.add("local"); continue; }
      manifestPath = join(root, "package.json");
    }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      names.add(typeof manifest.name === "string" && manifest.name.length <= 214 && NAME.test(manifest.name) ? manifest.name : "local");
    } catch { names.add("local"); }
  }
  if (names.size > 256) throw new Error("package inventory exceeds 256 packages");
  return [...names].sort();
}
export interface PackageInventory { names: string[]; durationMs: number }
interface InventoryCell { version: 1; signature: string; result: Promise<PackageInventory> }
const KEY = Symbol.for("pi.perf.package-inventory.v1");
/** Shared across /new, resume and runtime reloads, with no retained Pi context.
 * setImmediate keeps even the first filesystem request out of session_start. */
export function processPackageInventory(sources: readonly string[], cwd: string): Promise<PackageInventory> {
  const host = globalThis as Record<PropertyKey, unknown>;
  const signature = createHash("sha256").update(JSON.stringify([resolve(cwd), [...new Set(sources)].sort()])).digest("hex");
  const existing = host[KEY] as InventoryCell | undefined;
  if (existing?.version === 1 && existing.signature === signature) return existing.result;
  const result = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    const start = performance.now();
    const names = await resolvePackageNames(sources, cwd);
    return { names, durationMs: performance.now() - start };
  });
  host[KEY] = { version: 1, signature, result } satisfies InventoryCell;
  return result;
}
