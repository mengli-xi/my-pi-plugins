import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { captureEntrypointDescriptorV1 as capture, captureChildFactoryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { getSessionAssemblyPublicModules } from "../src/session-assembly.ts";
import { approveSdkProviderV1, sdkProviderApprovalV1, loadSdkProviderFactoryV1 } from "../src/sdk-provider.ts";
import { loadChildFactoryV1 } from "../src/child-factory.ts";

// Read Pi's actual extension table: an upstream alias addition/removal must fail
// the key-set assertion even when every existing fixture import still succeeds.
const { VIRTUAL_MODULES } = await import(new URL("./core/extensions/virtual-modules.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const names = Object.keys(VIRTUAL_MODULES);

test("canonical public module keys match the installed Pi extension loader table", () => {
  assert.deepEqual(Object.keys(getSessionAssemblyPublicModules()).sort(), [...names].sort());
});

test("SDK and ordinary child factories see every official Main loader alias with identical exported objects", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-public-modules-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"name":"public-module-fixture","type":"module"}');
  const path = join(root, "factory.ts");
  writeFileSync(path, names.map((name, i) => `import * as m${i} from ${JSON.stringify(name)};`).join("\n") + `
export function inspect() { return [${names.map((_, i) => `m${i}`).join(",")}]; }
export function create() { return pi => pi.events.emit("modules", inspect()); }
export default create();
`);
  const bus = createEventBus();
  let main: Record<string, unknown>[] = [];
  bus.on("modules", value => { main = value as typeof main; });
  // Invoke the installed official loader, not a replica of getAliases or our Jiti loader.
  const loader = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const result = await loader.loadExtensions([path], root, bus);
  assert.deepEqual(result.errors, []);
  assert.equal(main.length, names.length);
  const modules = getSessionAssemblyPublicModules();
  assert.deepEqual(Object.keys(modules).sort(), [...names].sort());
  const compare = (value: unknown) => {
    const child = value as typeof main;
    names.forEach((name, i) => {
      for (const key of Object.keys(main[i]!)) {
        if (key === "__esModule" || key === "module.exports") continue;
        assert.equal(child[i]![key], main[i]![key], `${name}.${key} must be the Main object`);
      }
    });
  };
  const descriptor = capture(path);
  const base = { child_entrypoint: descriptor, activation: "required-only" as const, commands: [], tools: [], hooks: [], requires: [] };
  const manifest = { version: 1 as const, owner_id: "fixture-provider", main_entrypoint: descriptor, targets: { child: { ...base,
    providers: [{ provider_id: "fixture", service_tiers: [], service_tier_application: "none" as const }],
    sdk_provider_factory: { provider_id: "fixture", package_manifest: capture(join(root, "package.json")), module: descriptor, export: "create", config: {}, artifacts: [] },
  } } };
  writeFileSync(join(root, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(manifest, "child")] }));
  const proof = approveSdkProviderV1(root, manifest, "child", ["fixture/local"]);
  const sdkFactory = await loadSdkProviderFactoryV1({ proof, agentDir: root, target: "child", modelScope: proof.model_scope, publicModules: modules });
  let calls = 0;
  const api = { on() {}, events: { emit(_channel: string, value: unknown) { calls++; compare(value); } } };
  await sdkFactory(api as never);
  const ordinary = await loadChildFactoryV1({ required: true, publicModules: modules, options: {}, proof: {
    version: 1, target_id: "child", context: {}, manifest: { version: 1, owner_id: "fixture-child", main_entrypoint: descriptor,
      targets: { child: { ...base, providers: [], child_factory: captureChildFactoryV1(path, { module: "factory.ts", export: "create", kind: "execution" }) } } },
  } });
  await ordinary!(api as never);
  assert.equal(calls, 2);
});
