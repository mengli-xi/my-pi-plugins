import { dirname, isAbsolute, join, relative } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { descriptor, captureEntrypointDescriptorV1, type EntrypointDescriptorV1 } from "#internal/child-capability-manifest";

export interface ChildFactoryV1 {
  readonly kind: "execution" | "presentation";
  readonly package_name: string;
  readonly package_manifest: EntrypointDescriptorV1;
  readonly module: string;
  readonly export: string;
  readonly artifacts: readonly string[];
  readonly files: readonly EntrypointDescriptorV1[];
}

function packagePath(main: string): string {
  let directory = dirname(main);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("child factory declaring package is unavailable");
    directory = parent;
  }
  return join(directory, "package.json");
}
function inside(root: string, path: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0")) throw new Error("child factory module must be package-relative");
  const file = realpathSync(join(root, path));
  const rel = relative(root, file);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("child factory path is outside declaring package");
  if (packagePath(file) !== join(root, "package.json")) throw new Error("child factory path belongs to another package");
  return file;
}
export function captureChildFactoryV1(main: string, declaration: { module: string; export: string; artifacts?: readonly string[]; kind?: "execution" | "presentation"; package_name?: string }): ChildFactoryV1 {
  const packageManifest = captureEntrypointDescriptorV1(packagePath(realpathSync(main)));
  const name = JSON.parse(readFileSync(packageManifest.canonical_path, "utf8")).name;
  if (typeof name !== "string" || !name || declaration.package_name !== undefined && declaration.package_name !== name) throw new Error("capability-drift: child factory declaring package name mismatch");
  if (!/^[A-Za-z_$][\w$]*$/u.test(declaration.export)) throw new Error("child factory export is invalid");
  const kind = declaration.kind ?? "execution";
  if (kind !== "execution" && kind !== "presentation") throw new Error("child factory kind is invalid");
  const artifacts = [...(declaration.artifacts ?? [])];
  if (artifacts.length > 128 || new Set([declaration.module, ...artifacts]).size !== artifacts.length + 1) throw new Error("child factory artifacts are invalid");
  const root = dirname(packageManifest.canonical_path);
  return Object.freeze({ kind, package_name: name, package_manifest: packageManifest, module: declaration.module, export: declaration.export,
    artifacts: Object.freeze(artifacts), files: Object.freeze([declaration.module, ...artifacts].map(path => captureEntrypointDescriptorV1(inside(root, path)))) });
}
export function validateChildFactoryV1(value: unknown, main: string, verifyFiles = true): ChildFactoryV1 {
  const item = value as ChildFactoryV1;
  if (!item || Object.keys(item).sort().join() !== ["kind", "package_name", "package_manifest", "module", "export", "artifacts", "files"].sort().join()
    || !Array.isArray(item.artifacts) || !Array.isArray(item.files) || item.files.length !== item.artifacts.length + 1) throw new Error("invalid child factory declaration");
  if (!verifyFiles) {
    // Serialized proofs are still structurally validated, without touching retired files.
    if (!["execution", "presentation"].includes(item.kind) || typeof item.package_name !== "string" || !/^[A-Za-z_$][\w$]*$/u.test(item.export)
      || [item.module, ...item.artifacts].some(path => typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/u).includes(".."))
      || [item.package_manifest, ...item.files].some(file => !file || !isAbsolute(file.canonical_path) || !/^[a-f0-9]{64}$/u.test(file.sha256))) throw new Error("invalid child factory proof");
    descriptor(item.package_manifest, "child factory package manifest", false);
    for (const file of item.files) descriptor(file, "child factory file", false);
    return Object.freeze(structuredClone(item));
  }
  const current = captureChildFactoryV1(main, item);
  const expected = { kind: item.kind, package_name: item.package_name, package_manifest: descriptor(item.package_manifest, "capability-drift: child factory package manifest"), module: item.module, export: item.export, artifacts: item.artifacts, files: item.files.map(file => descriptor(file, "capability-drift: child factory file")) };
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("capability-drift: child factory does not match live file identity");
  return current;
}

export function assertChildFactoryEntrypointV1(factory: ChildFactoryV1, child: EntrypointDescriptorV1): void {
  const root = dirname(factory.package_manifest.canonical_path);
  inside(root, relative(root, child.canonical_path));
}
