import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Canonicalize public tool provenance consistently across child consumers. */
export function sourcePath(source: { readonly path: string; readonly baseDir?: string }): string {
  const candidate = isAbsolute(source.path) ? source.path : source.baseDir ? resolve(source.baseDir, source.path) : "";
  if (!candidate) throw new Error("extension tool source has no canonical base");
  return realpathSync(candidate);
}
