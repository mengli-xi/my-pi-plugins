import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

type FileSnapshot = { exists: false; version: "missing"; text: "" } | { exists: true; version: string; text: string; error?: FileReadError };
const snapshots = new Map<string, FileSnapshot>();

/** Only metadata goes into diagnostics: parser errors can contain config text or credentials. */
export class FileReadError extends Error {
  readonly kind: "malformed" | "io";
  readonly code?: string;

  constructor(path: string, kind: "malformed" | "io", code?: string) {
    super(`Cannot read ${path}: ${kind === "malformed" ? "malformed file" : `I/O error (${code ?? "unknown"})`}`);
    this.name = "FileReadError";
    this.kind = kind;
    if (code !== undefined) this.code = code;
  }
}

function version(path: string, fd?: number): string {
  const info = fd === undefined ? statSync(path, { bigint: true }) : fstatSync(fd, { bigint: true });
  if (!info.isFile()) {
    snapshots.delete(path);
    throw new FileReadError(path, "io", info.isDirectory() ? "EISDIR" : "EINVAL");
  }
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function snapshot(path: string): FileSnapshot {
  path = resolve(path);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = version(path);
      const cached = snapshots.get(path);
      if (cached?.exists && cached.version === before) {
        if (cached.error) throw cached.error;
        return cached;
      }
      let text: string;
      try {
        // A regular config can be replaced with a FIFO between stat and open.
        const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          if (version(path, fd) !== before) continue;
          text = readFileSync(fd, "utf8");
          if (version(path, fd) !== before) continue;
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if (version(path) !== before) continue;
        const failure = new FileReadError(path, "io", (error as NodeJS.ErrnoException).code);
        snapshots.set(path, { exists: true, version: before, text: "", error: failure });
        throw failure;
      }
      if (version(path) !== before) continue;
      const next = { exists: true as const, version: before, text };
      snapshots.set(path, next);
      return next;
    }
    throw new FileReadError(path, "io", "EBUSY");
  } catch (error) {
    if (error instanceof FileReadError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const missing = { exists: false as const, version: "missing" as const, text: "" as const };
      snapshots.set(path, missing);
      return missing;
    }
    snapshots.delete(path);
    throw new FileReadError(path, "io", code);
  }
}

/** Check cheap metadata on every access, but read and parse each stable file version only once. */
export function createFileReader<T>(parse: (text: string, path: string) => T): (path: string) => { exists: boolean; text: string; value: T | undefined } {
  const parsed = new Map<string, { version: string; value?: T; error?: FileReadError }>();
  return (path) => {
    path = resolve(path);
    const file = snapshot(path);
    if (!file.exists) {
      parsed.delete(path);
      return { exists: false, text: "", value: undefined };
    }
    let cached = parsed.get(path);
    if (cached?.version !== file.version) {
      try {
        cached = { version: file.version, value: parse(file.text, path) };
      } catch (error) {
        cached = { version: file.version, error: error instanceof FileReadError ? error : new FileReadError(path, "malformed") };
      }
      parsed.set(path, cached);
    }
    if (cached.error) throw cached.error;
    return { exists: true, text: file.text, value: cached.value };
  };
}

export const readTextFile = createFileReader(text => text);

export function describeFileError(error: unknown): string {
  return error instanceof FileReadError ? error.message : `File operation failed (${(error as NodeJS.ErrnoException)?.code ?? "unknown"})`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
    : entry);
}
