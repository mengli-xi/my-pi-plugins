import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackageSource } from "@earendil-works/pi-coding-agent";

import type { PackageLocator } from "./types.js";

interface SnapshotFile {
  version: 1;
  key: string;
  entry: PackageSource;
}

export class SnapshotStore {
  private readonly root: string;
  private readonly cwd: string;
  private readonly agentDir: string;

  constructor(root: string, cwd: string, agentDir: string) {
    this.root = root;
    this.cwd = cwd;
    this.agentDir = agentDir;
  }

  private key(locator: PackageLocator): string {
    const base = locator.scope === "project" ? this.cwd : this.agentDir;
    return `${locator.scope}\0${base}\0${locator.source}`;
  }

  private path(locator: PackageLocator): string {
    const digest = createHash("sha256").update(this.key(locator)).digest("hex");
    return join(this.root, `${digest}.json`);
  }

  async read(locator: PackageLocator): Promise<PackageSource | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path(locator), "utf8")) as SnapshotFile;
      if (!parsed || parsed.version !== 1 || parsed.key !== this.key(locator)) {
        throw new Error("Snapshot version or identity does not match");
      }
      const entry = parsed.entry;
      if (typeof entry === "string") {
        if (entry !== locator.source) throw new Error("Snapshot source does not match");
        return entry;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.source !== locator.source ||
          (entry.autoload !== undefined && typeof entry.autoload !== "boolean") ||
          ["extensions", "skills", "prompts", "themes"].some((key) => {
            const value = (entry as Record<string, unknown>)[key];
            return value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"));
          })) {
        throw new Error("Snapshot entry or filters are invalid");
      }
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot restore disabled-package snapshot; saved filters were left unchanged", { cause: error });
    }
  }

  async write(locator: PackageLocator, entry: PackageSource): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.path(locator);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const payload: SnapshotFile = { version: 1, key: this.key(locator), entry };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async remove(locator: PackageLocator): Promise<void> {
    await rm(this.path(locator), { force: true });
  }
}
