import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostPi from "@earendil-works/pi-coding-agent";
import { loadApprovedFactoryModule } from "../src/factory-loader.ts";
test("factory modules resolve the supplied host class identity and cache only module exports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-factory-module-"));
  try {
    const path = join(dir, "factory.ts");
    await writeFile(path, 'import { SessionManager } from "@earendil-works/pi-coding-agent"; export function createChildFactory(options: {name:string}) { return { name: options.name, SessionManager }; }');
    const publicModules = { "@earendil-works/pi-coding-agent": hostPi };
    const first = await loadApprovedFactoryModule({ path, exports: ["createChildFactory"], publicModules });
    const second = await loadApprovedFactoryModule({ path, exports: ["createChildFactory"], publicModules: { ...publicModules } });
    assert.equal(first.createChildFactory, second.createChildFactory);
    const create = first.createChildFactory as (options: { name: string }) => { name: string; SessionManager: unknown };
    const a = create({ name: "a" }), b = create({ name: "b" });
    assert.equal(a.SessionManager, hostPi.SessionManager); assert.equal(b.SessionManager, hostPi.SessionManager);
    assert.equal(a.name, "a"); assert.equal(b.name, "b");
    await assert.rejects(loadApprovedFactoryModule({ path, exports: ["default"], publicModules }), /export is missing/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
