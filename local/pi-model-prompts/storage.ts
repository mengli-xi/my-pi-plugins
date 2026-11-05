import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Snapshot<T> {
  version: string;
  value?: T;
  error?: Error;
}

// These caches own filesystem versions, not session state. Following the target
// stat keeps explicitly configured prompt symlinks working after target edits.
const texts = new Map<string, Snapshot<string>>();
const directories = new Map<string, Snapshot<string[]>>();
const links = new Map<string, Snapshot<string | undefined>>();
const warned = new WeakSet<Error>();

function readCached<T>(path: string, cache: Map<string, Snapshot<T>>, read: () => T, link = false): Snapshot<T> {
  let version: string;
  let failure: unknown;
  try {
    const stat = link ? lstatSync(path, { bigint: true }) : statSync(path, { bigint: true });
    version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    version = `stat:${code}`;
    if (code !== "ENOENT") failure = error;
  }
  const cached = cache.get(path);
  if (cached?.version === version) return cached;
  const snapshot: Snapshot<T> = { version };
  try {
    if (failure) throw failure;
    if (version !== "stat:ENOENT") snapshot.value = read();
  } catch (error) {
    snapshot.error = new Error(`${basename(path)}: ${(error as NodeJS.ErrnoException)?.code ?? "read failed"}`, { cause: error });
  }
  cache.set(path, snapshot);
  return snapshot;
}

export function readTextSnapshot(path: string): Snapshot<string> {
  return readCached(path, texts, () => readFileSync(path, "utf8"));
}

export function reportStorageError(error: Error): void {
  if (warned.has(error)) return;
  warned.add(error);
  console.error(`pi-model-prompts: ${error.message}`);
}

export function readPrompt(path: string): string | undefined {
  const snapshot = readTextSnapshot(path);
  if (snapshot.error) reportStorageError(snapshot.error);
  return snapshot.value?.trim() || undefined;
}

export function markdownNames(dir: string): string[] {
  const snapshot = readCached(dir, directories, () => readdirSync(dir).filter((name) => name.endsWith(".md")).sort());
  if (snapshot.error) reportStorageError(snapshot.error);
  return snapshot.value ?? [];
}

export function linkTarget(path: string): string | undefined {
  const snapshot = readCached(path, links,
    () => lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined, true);
  if (snapshot.error) reportStorageError(snapshot.error);
  return snapshot.value;
}

/** Atomic visibility, plus optimistic detection of edits made while a panel was open. */
export function writeTextAtomic(path: string, text: string, expectedVersion: string): void {
  const assertUnchanged = (): void => {
    const current = readTextSnapshot(path);
    if (current.error) throw current.error;
    if (current.version !== expectedVersion) throw new Error(`${basename(path)} changed; reopen settings before saving.`);
  };
  assertUnchanged();
  let mode = 0o600;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`${basename(path)} is a symlink; refusing to replace it.`);
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx", mode });
    chmodSync(temporary, mode);
    assertUnchanged();
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
