import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  DefaultPackageManager,
  SettingsManager,
  type PackageSource,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";

import { fallbackDisplayName, packageIdentity, packageKind } from "./identity.js";
import { SnapshotStore } from "./snapshots.js";
import type {
  ConfiguredPackageEntry,
  ManagedPackage,
  PackageLocator,
  PackageManifestInfo,
  PackageScope,
} from "./types.js";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

type PackageManagerLike = Pick<
  DefaultPackageManager,
  "checkForAvailableUpdates" | "getInstalledPath" | "setProgressCallback" | "update"
>;

type PackageManagerFactory = (settingsManager: SettingsManager) => PackageManagerLike;

export interface PackageCatalogOptions {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  managerRoot: string;
  packageManagerFactory?: PackageManagerFactory;
  snapshotStore?: SnapshotStore;
}

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isManagerMarker(entry: PackageSource): boolean {
  return (
    typeof entry === "object" &&
    entry.autoload === false &&
    Object.keys(entry).every((key) => key === "source" || key === "autoload")
  );
}

function entryCanLoadResources(entry: PackageSource): boolean {
  if (typeof entry === "string" || entry.autoload !== false) return true;
  return RESOURCE_TYPES.some((resourceType) =>
    (entry[resourceType] ?? []).some((pattern) => !pattern.startsWith("-") && !pattern.startsWith("!")),
  );
}

function enableEntry(entry: PackageSource): PackageSource {
  if (typeof entry === "string") return entry;
  const next = { ...entry };
  delete next.autoload;
  return Object.keys(next).length === 1 ? next.source : next;
}

function settingsErrorMessage(settingsManager: SettingsManager): string | undefined {
  const errors = settingsManager.drainErrors();
  if (errors.length === 0) return undefined;
  return errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("\n");
}

async function normalizedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function repositoryUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "url" in value && typeof value.url === "string") {
    return value.url;
  }
  return undefined;
}

async function countFiles(root: string, resourceType: ResourceType): Promise<number> {
  const target = join(root, resourceType);
  const matches = (name: string): boolean => {
    if (resourceType === "extensions") return /\.[cm]?[jt]s$/i.test(name);
    if (resourceType === "themes") return name.endsWith(".json");
    return name.endsWith(".md");
  };

  const visit = async (path: string): Promise<number> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return 0;
    }

    let count = 0;
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) count += await visit(join(path, entry.name));
      else if (entry.isFile() && matches(entry.name)) count += 1;
    }
    return count;
  };

  return visit(target);
}

async function readManifestInfo(installedPath: string | undefined): Promise<PackageManifestInfo> {
  const empty: PackageManifestInfo = { resourceCounts: {} };
  if (!installedPath) return empty;

  let root = installedPath;
  try {
    if (!(await stat(installedPath)).isDirectory()) root = dirname(installedPath);
  } catch {
    return empty;
  }

  let manifest: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      manifest = parsed as Record<string, unknown>;
    }
  } catch {
    // A local single-file extension is a valid package source without package.json.
  }

  const pi = manifest?.pi;
  const piManifest = pi && typeof pi === "object" && !Array.isArray(pi)
    ? (pi as Record<string, unknown>)
    : undefined;
  const resourceCounts: PackageManifestInfo["resourceCounts"] = {};

  await Promise.all(
    RESOURCE_TYPES.map(async (resourceType) => {
      const declared = piManifest?.[resourceType];
      if (Array.isArray(declared)) {
        resourceCounts[resourceType] = declared.filter((item) => typeof item === "string").length;
        return;
      }
      const count = await countFiles(root, resourceType);
      if (count > 0) resourceCounts[resourceType] = count;
    }),
  );

  const text = (key: string): string | undefined =>
    typeof manifest?.[key] === "string" ? manifest[key] : undefined;

  return {
    name: text("name"),
    version: text("version"),
    description: text("description"),
    license: text("license"),
    homepage: text("homepage"),
    repository: repositoryUrl(manifest?.repository),
    resourceCounts,
  };
}

function choosePrimary(entries: ConfiguredPackageEntry[]): ConfiguredPackageEntry {
  return (
    entries.find((entry) => entry.scope === "project" && entry.enabled && entry.installedPath) ??
    entries.find((entry) => entry.scope === "global" && entry.enabled && entry.installedPath) ??
    entries.find((entry) => entry.enabled && entry.installedPath) ??
    entries.find((entry) => entry.scope === "project" && entry.installedPath) ??
    entries.find((entry) => entry.installedPath) ??
    entries.find((entry) => entry.scope === "project" && entry.enabled) ??
    entries.find((entry) => entry.enabled) ??
    entries.find((entry) => entry.scope === "project") ??
    entries[0]!
  );
}

function isManagerPath(path: string, managerRoot: string): boolean {
  return path === managerRoot || path.startsWith(`${managerRoot}${sep}`);
}

export class MissingSnapshotError extends Error {
  constructor() {
    super("No disabled-package snapshot is available; enabling requires consent to load without saved filters");
    this.name = "MissingSnapshotError";
  }
}

export class PackageCatalog {
  private readonly options: PackageCatalogOptions;
  private readonly snapshots: SnapshotStore;
  private readonly packageManagerFactory: PackageManagerFactory;

  constructor(options: PackageCatalogOptions) {
    this.options = options;
    this.snapshots =
      options.snapshotStore ??
      new SnapshotStore(join(options.agentDir, "pi-package-manager", "disabled"), options.cwd, options.agentDir);
    this.packageManagerFactory =
      options.packageManagerFactory ??
      ((settingsManager) =>
        new DefaultPackageManager({
          cwd: options.cwd,
          agentDir: options.agentDir,
          settingsManager,
        }));
  }

  private settingsManager(): SettingsManager {
    const manager = SettingsManager.create(this.options.cwd, this.options.agentDir, {
      projectTrusted: this.options.projectTrusted,
    });
    const error = settingsErrorMessage(manager);
    if (error) throw new Error(`Cannot read Pi settings:\n${error}`);
    return manager;
  }

  private collectEntries(
    settingsManager: SettingsManager,
    packageManager: PackageManagerLike,
  ): ConfiguredPackageEntry[] {
    const result: ConfiguredPackageEntry[] = [];
    const add = (scope: PackageScope, packages: PackageSource[]) => {
      for (const [index, raw] of packages.entries()) {
        const source = sourceOf(raw);
        result.push({
          scope,
          index,
          source,
          raw,
          enabled: entryCanLoadResources(raw),
          filtered: typeof raw === "object",
          installedPath: packageManager.getInstalledPath(source, scope === "global" ? "user" : "project"),
        });
      }
    };

    add("global", settingsManager.getGlobalSettings().packages ?? []);
    if (this.options.projectTrusted) {
      add("project", settingsManager.getProjectSettings().packages ?? []);
    }
    return result;
  }

  async list(): Promise<ManagedPackage[]> {
    const settingsManager = this.settingsManager();
    const packageManager = this.packageManagerFactory(settingsManager);
    const entries = this.collectEntries(settingsManager, packageManager);
    const groups = new Map<string, ConfiguredPackageEntry[]>();

    for (const entry of entries) {
      const identity = packageIdentity(
        entry.source,
        entry.scope,
        this.options.cwd,
        this.options.agentDir,
      );
      const group = groups.get(identity) ?? [];
      group.push(entry);
      groups.set(identity, group);
    }

    const managerRoot = await normalizedPath(this.options.managerRoot);
    const packages = await Promise.all(
      [...groups.entries()].map(async ([id, groupedEntries]): Promise<ManagedPackage> => {
        const primary = choosePrimary(groupedEntries);
        const installedPath = primary.installedPath;
        const manifest = await readManifestInfo(installedPath);
        const installedRoots = await Promise.all(
          groupedEntries.flatMap((entry) => (entry.installedPath ? [normalizedPath(entry.installedPath)] : [])),
        );
        return {
          id,
          source: primary.source,
          displayName: manifest.name ?? fallbackDisplayName(primary.source),
          kind: packageKind(primary.source),
          enabled: groupedEntries.some((entry) => entry.enabled),
          missing: groupedEntries.every((entry) => entry.installedPath === undefined),
          protected: installedRoots.some((path) => isManagerPath(path, managerRoot)),
          entries: groupedEntries,
          installedPath,
          manifest,
        };
      }),
    );

    return packages.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async setEnabled(
    packageId: string,
    enabled: boolean,
    options: { allowWithoutSnapshot?: boolean } = {},
  ): Promise<void> {
    const settingsManager = this.settingsManager();
    const packageManager = this.packageManagerFactory(settingsManager);
    const entries = this.collectEntries(settingsManager, packageManager).filter(
      (entry) =>
        packageIdentity(entry.source, entry.scope, this.options.cwd, this.options.agentDir) === packageId,
    );
    if (entries.length === 0) throw new Error("Package is no longer present in settings");
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = JSON.stringify([entry.scope, entry.source]);
      if (seen.has(key)) throw new Error("Duplicate sources in one scope cannot be toggled safely; resolve duplicate settings entries first");
      seen.add(key);
    }

    const managerRoot = await normalizedPath(this.options.managerRoot);
    const entryPaths = await Promise.all(
      entries.flatMap((entry) => (entry.installedPath ? [normalizedPath(entry.installedPath)] : [])),
    );
    if (!enabled && entryPaths.some((path) => isManagerPath(path, managerRoot))) {
      throw new Error("pi-package-manager cannot disable itself; use pi config if this is intentional");
    }

    const globalPackages = [...(settingsManager.getGlobalSettings().packages ?? [])];
    const projectPackages = [...(settingsManager.getProjectSettings().packages ?? [])];
    const currentEntry = (locator: PackageLocator): PackageSource =>
      (locator.scope === "global" ? globalPackages : projectPackages)[locator.index]!;
    const replaceEntry = (locator: PackageLocator, value: PackageSource): void => {
      (locator.scope === "global" ? globalPackages : projectPackages)[locator.index] = value;
    };

    let changed = false;
    const snapshots = new Map<ConfiguredPackageEntry, PackageSource | undefined>();
    if (enabled) {
      await Promise.all(
        entries.map(async (entry) => snapshots.set(entry, await this.snapshots.read(entry))),
      );
      const restoringManagerChange = [...snapshots.values()].some((entry) => entry !== undefined);
      if (!options.allowWithoutSnapshot && entries.some(
        (entry) => snapshots.get(entry) === undefined && isManagerMarker(currentEntry(entry)),
      )) throw new MissingSnapshotError();

      for (const entry of entries) {
        const current = currentEntry(entry);
        const snapshot = snapshots.get(entry);
        if (snapshot !== undefined) {
          if (isManagerMarker(current)) {
            replaceEntry(entry, snapshot);
            changed = true;
          }
          continue;
        }
        if ((!restoringManagerChange || (options.allowWithoutSnapshot && isManagerMarker(current))) &&
            typeof current === "object" && current.autoload === false) {
          replaceEntry(entry, enableEntry(current));
          changed = true;
        }
      }
    } else {
      for (const entry of entries) {
        const current = currentEntry(entry);
        if (isManagerMarker(current)) continue;
        await this.snapshots.write(entry, current);
        replaceEntry(entry, { source: sourceOf(current), autoload: false });
        changed = true;
      }
    }

    if (!changed) return;
    if (entries.some((entry) => entry.scope === "global")) settingsManager.setPackages(globalPackages);
    if (entries.some((entry) => entry.scope === "project")) {
      settingsManager.setProjectPackages(projectPackages);
    }
    await settingsManager.flush();
    const writeError = settingsErrorMessage(settingsManager);
    if (writeError) throw new Error(`Could not write Pi settings:\n${writeError}`);

    if (enabled) {
      await Promise.all(
        entries.flatMap((entry) => (snapshots.get(entry) === undefined ? [] : [this.snapshots.remove(entry)])),
      );
    }
  }

  async checkForUpdates(onProgress?: (event: ProgressEvent) => void): Promise<Set<string>> {
    const settingsManager = this.settingsManager();
    const packageManager = this.packageManagerFactory(settingsManager);
    packageManager.setProgressCallback(onProgress);
    try {
      const updates = await packageManager.checkForAvailableUpdates();
      return new Set(
        updates.map((update) =>
          packageIdentity(
            update.source,
            update.scope === "user" ? "global" : "project",
            this.options.cwd,
            this.options.agentDir,
          ),
        ),
      );
    } finally {
      packageManager.setProgressCallback(undefined);
    }
  }

  async update(pkg: ManagedPackage, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    if (pkg.kind === "local") throw new Error("Local path packages are not updateable");
    const settingsManager = this.settingsManager();
    const packageManager = this.packageManagerFactory(settingsManager);
    packageManager.setProgressCallback(onProgress);
    try {
      await packageManager.update(pkg.source);
    } finally {
      packageManager.setProgressCallback(undefined);
    }
  }
}

export const packageCatalogInternals = {
  enableEntry,
  entryCanLoadResources,
  isManagerMarker,
};
