import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostPi from "@earendil-works/pi-coding-agent";
import { getSessionAssemblyPublicModules } from "../src/session-assembly.ts";
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

test("all public aliases fence same-path cache reuse; different tables never share a Jiti resolver", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-factory-alias-realm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modules = getSessionAssemblyPublicModules();
  const source = 'import * as core from "@earendil-works/pi-agent-core"; export function inspect() { return core; }';
  const path = join(dir, "one.ts"), secondPath = join(dir, "two.ts");
  await writeFile(path, source); await writeFile(secondPath, source);
  await loadApprovedFactoryModule({ path, exports: ["inspect"], publicModules: modules });
  for (const name of Object.keys(modules)) {
    await assert.rejects(loadApprovedFactoryModule({ path, exports: ["inspect"], publicModules: { ...modules, [name]: {} } }), /SDK realm changed/);
  }
  const otherCore = { Agent: () => "other" };
  const second = await loadApprovedFactoryModule({ path: secondPath, exports: ["inspect"], publicModules: { ...modules, "@earendil-works/pi-agent-core": otherCore } });
  assert.equal((second.inspect as () => typeof otherCore)().Agent, otherCore.Agent);
});
