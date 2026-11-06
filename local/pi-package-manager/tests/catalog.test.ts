import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SettingsManager } from "@earendil-works/pi-coding-agent";

import { PackageCatalog } from "../src/catalog.ts";
import { packageIdentity } from "../src/identity.ts";
import { SnapshotStore } from "../src/snapshots.ts";

async function fixture(globalPackages: unknown[], projectPackages: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-package-manager-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: globalPackages }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: projectPackages }));

  const fakePackageManager = (_settingsManager: SettingsManager) => ({
    getInstalledPath: () => undefined,
    setProgressCallback: () => undefined,
    checkForAvailableUpdates: async () => [],
    update: async () => undefined,
  });
  const catalog = new PackageCatalog({
    cwd,
    agentDir,
    projectTrusted: true,
    managerRoot: join(root, "manager"),
    packageManagerFactory: fakePackageManager,
    snapshotStore: new SnapshotStore(join(root, "snapshots"), cwd, agentDir),
  });

  return {
    root,
    agentDir,
    cwd,
    catalog,
    cleanup: () => rm(root, { recursive: true, force: true }),
    readGlobal: async () => JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")),
    readProject: async () => JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")),
  };
}

test("global and project entries are one logical package", async (t) => {
  const f = await fixture(
    ["npm:dual"],
    [{ source: "npm:dual@latest", autoload: false, extensions: ["-legacy.ts"] }],
  );
  t.after(f.cleanup);

  const packages = await f.catalog.list();
  assert.equal(packages.length, 1);
  assert.equal(packages[0]?.entries.length, 2);
  assert.equal(packages[0]?.enabled, true);
});

test("disable and enable restore exact filters in both scopes", async (t) => {
  const globalEntry = { source: "npm:dual", extensions: ["extensions/*.ts", "-extensions/old.ts"] };
  const projectEntry = { source: "npm:dual@latest", autoload: false, skills: ["+skills/team/SKILL.md"] };
  const f = await fixture([globalEntry], [projectEntry]);
  t.after(f.cleanup);
  const id = packageIdentity("npm:dual", "global", f.cwd, f.agentDir);

  await f.catalog.setEnabled(id, false);
  assert.deepEqual((await f.readGlobal()).packages, [{ source: "npm:dual", autoload: false }]);
  assert.deepEqual((await f.readProject()).packages, [
    { source: "npm:dual@latest", autoload: false },
  ]);

  await f.catalog.setEnabled(id, true);
  assert.deepEqual((await f.readGlobal()).packages, [globalEntry]);
  assert.deepEqual((await f.readProject()).packages, [projectEntry]);
});

test("enabling a pre-existing disabled entry preserves filters", async (t) => {
  const f = await fixture(
    [{ source: "npm:off", autoload: false, extensions: ["-extensions/legacy.ts"] }],
    [],
  );
  t.after(f.cleanup);
  const id = packageIdentity("npm:off", "global", f.cwd, f.agentDir);

  await f.catalog.setEnabled(id, true);
  assert.deepEqual((await f.readGlobal()).packages, [
    { source: "npm:off", extensions: ["-extensions/legacy.ts"] },
  ]);
});

test("update checks and updates delegate to Pi's package manager", async (t) => {
  const f = await fixture(["npm:updatable"], []);
  t.after(f.cleanup);
  const updated: string[] = [];
  const catalog = new PackageCatalog({
    cwd: f.cwd,
    agentDir: f.agentDir,
    projectTrusted: true,
    managerRoot: join(f.root, "manager"),
    packageManagerFactory: () => ({
      getInstalledPath: () => f.root,
      setProgressCallback: () => undefined,
      checkForAvailableUpdates: async () => [{
        source: "npm:updatable",
        displayName: "updatable",
        type: "npm" as const,
        scope: "user" as const,
      }],
      update: async (source?: string) => void updated.push(source ?? ""),
    }),
  });

  const packages = await catalog.list();
  assert.deepEqual(await catalog.checkForUpdates(), new Set([packages[0]!.id]));
  await catalog.update(packages[0]!);
  assert.deepEqual(updated, ["npm:updatable"]);
});

test("damaged or mismatched snapshots never replace disabled settings", async (t) => {
  const entry = { source: "npm:filtered", extensions: ["+safe.ts"] };
  const f = await fixture([entry], []);
  t.after(f.cleanup);
  const id = packageIdentity(entry.source, "global", f.cwd, f.agentDir);
  await f.catalog.setEnabled(id, false);
  const path = join(f.root, "snapshots", (await readdir(join(f.root, "snapshots")))[0]!);
  const saved = JSON.parse(await readFile(path, "utf8"));
  const disabled = await f.readGlobal();
  for (const text of ["{broken", JSON.stringify({ ...saved, version: 2 }),
    JSON.stringify({ ...saved, entry: { source: "npm:unexpected" } }),
    JSON.stringify({ ...saved, entry: { ...entry, extensions: "not-an-array" } })]) {
    await writeFile(path, text);
    await assert.rejects(f.catalog.setEnabled(id, true), /snapshot/i);
    assert.deepEqual(await f.readGlobal(), disabled);
    assert.equal(await readFile(path, "utf8"), text);
  }
});

test("missing filters require explicit consent before either scope is changed", async (t) => {
  const globalEntry = { source: "npm:filtered", extensions: ["+safe.ts"] };
  const projectEntry = { source: "npm:filtered", skills: ["+safe/SKILL.md"] };
  const f = await fixture([globalEntry], [projectEntry]);
  t.after(f.cleanup);
  const id = packageIdentity(globalEntry.source, "global", f.cwd, f.agentDir);
  await f.catalog.setEnabled(id, false);
  for (const file of await readdir(join(f.root, "snapshots"))) {
    const path = join(f.root, "snapshots", file);
    if (JSON.parse(await readFile(path, "utf8")).key.startsWith("project\u0000")) await rm(path);
  }
  const beforeGlobal = await f.readGlobal();
  const beforeProject = await f.readProject();
  await assert.rejects(f.catalog.setEnabled(id, true), /snapshot/i);
  assert.deepEqual(await f.readGlobal(), beforeGlobal);
  assert.deepEqual(await f.readProject(), beforeProject);
  await f.catalog.setEnabled(id, true, { allowWithoutSnapshot: true });
  assert.deepEqual((await f.readGlobal()).packages, [globalEntry]);
  assert.deepEqual((await f.readProject()).packages, ["npm:filtered"]);
});

test("duplicate sources in one scope are rejected before backups or settings change", async (t) => {
  const entries = [{ source: "npm:duplicate", extensions: ["+a.ts"] },
    { source: "npm:duplicate", skills: ["+b/SKILL.md"] }];
  const f = await fixture(entries, []);
  t.after(f.cleanup);
  const id = packageIdentity("npm:duplicate", "global", f.cwd, f.agentDir);
  await assert.rejects(f.catalog.setEnabled(id, false), /duplicate/i);
  assert.deepEqual((await f.readGlobal()).packages, entries);
  await assert.rejects(readdir(join(f.root, "snapshots")), { code: "ENOENT" });
});
