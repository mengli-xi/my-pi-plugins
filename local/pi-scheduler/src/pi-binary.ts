import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

interface PiHost {
  execPath: string;
  packageDir: string;
  bun: boolean;
  override?: string;
}

/** Resolve in the Pi process, before its identity crosses into the daemon environment. */
export function resolvePiBinary(host: PiHost = {
  execPath: process.execPath,
  packageDir: getPackageDir(),
  bun: !!process.versions.bun,
  override: process.env.PI_SCHEDULER_BINARY,
}): string {
  const executable = (path: string): string => {
    const absolute = realpathSync(resolve(path));
    if (!statSync(absolute).isFile()) throw new Error(`Not a file: ${absolute}`);
    accessSync(absolute, constants.X_OK);
    return absolute;
  };
  try {
    if (host.override?.trim()) return executable(host.override.trim());
    const packageDir = realpathSync(resolve(host.packageDir));
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    if (manifest.name !== "@earendil-works/pi-coding-agent") throw new Error("Unrecognized Pi package identity");
    // Pi 1.5's public getPackageDir contract returns the executable directory for
    // its Bun compiled distribution, but the package root for script runtimes.
    // Only that compiled case reuses execPath; Node/Bun SDK caller scripts are
    // never Pi entrypoints. Missing/changed package/bin evidence fails closed.
    const runtime = executable(host.execPath);
    if (host.bun && dirname(runtime) === packageDir) return runtime;
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (typeof bin !== "string" || !bin || isAbsolute(bin)) throw new Error("Pi package has no relative CLI bin");
    const entry = resolve(packageDir, bin);
    if (relative(packageDir, entry).split(sep)[0] === "..") throw new Error("Pi CLI bin escapes its package");
    return executable(entry);
  } catch (cause) {
    throw new Error("Cannot resolve an executable Pi CLI; set PI_SCHEDULER_BINARY explicitly", { cause });
  }
}
