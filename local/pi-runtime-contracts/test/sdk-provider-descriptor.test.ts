import assert from "node:assert/strict";
import test from "node:test";
import { validateSdkProviderFactoryV1 } from "pi-runtime-contracts/child-capabilities-v1";
const descriptor = { canonical_path: "/faux/file.ts", sha256: "a".repeat(64), device: "1", inode: "2", size: 1, mtime_ns: "3" };
const factory = { provider_id: "unbranded", package_manifest: { ...descriptor, canonical_path: "/faux/package.json" }, module: descriptor, export: "createChild", config: { nested: { valid: [null, true, 3] } }, artifacts: [] };
test("SDK factory descriptor is closed pure data with bounded canonical JSON config", () => {
  const parsed = validateSdkProviderFactoryV1(factory, false);
  assert(Object.isFrozen(parsed.config));
  assert.deepEqual(parsed.config, factory.config);
  for (const change of [{ unknown: true }, { export: "not-an-export" }, { provider_id: "UPPER" }, { config: { invalid: () => {} } }, { config: { number: Infinity } }, { config: { huge: "x".repeat(32769) } }, { config: JSON.parse('{"__proto__":true}') }, { observer: { module: descriptor, export: "observe", input_channel: "input", output_channel: "forged" } }]) {
    assert.throws(() => validateSdkProviderFactoryV1({ ...factory, ...change }, false));
  }
  let deep: unknown = {}; for (let i = 0; i < 15; i++) deep = { deep };
  assert.throws(() => validateSdkProviderFactoryV1({ ...factory, config: deep }, false), /bounds/);
});
