import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const SYMBOL = Symbol.for("pi.runtime-contracts.continuation.v1");

test("physically separate module copies converge on one global registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-contracts-"));
  const source = new URL("../src/", import.meta.url);
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([first, second].map(async (target) => {
    await mkdir(join(target, "src"), { recursive: true });
    await cp(source, join(target, "src"), { recursive: true });
    await cp(new URL("../package.json", import.meta.url), join(target, "package.json"));
  }));
  try {
    const one = await import(
      `${pathToFileURL(join(first, "src", "continuation-v1.ts")).href}?copy=1`
    );
    const two = await import(
      `${pathToFileURL(join(second, "src", "continuation-v1.ts")).href}?copy=2`
    );
    const registryOne = one.getContinuationRegistryV1();
    const registryTwo = two.getContinuationRegistryV1();
    assert.equal(registryOne, registryTwo);

    const sessionId = `copy-test-${crypto.randomUUID()}`;
    const lease = registryOne.acquireBlocking({
      sessionId,
      ownerId: "copy-test",
      logicalKey: "shared",
    });
    assert.equal(lease.ok, true);
    assert.equal(registryTwo.snapshot(sessionId).blocking.length, 1);
    if (lease.ok) lease.value.releaseWithoutWake({ outcome: "cancelled" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physically separate module copies share the child capability registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-capability-copies-"));
  const source = new URL("../src/", import.meta.url);
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([first, second].map(async (target) => {
    await mkdir(join(target, "src"), { recursive: true });
    await cp(source, join(target, "src"), { recursive: true });
    await cp(new URL("../package.json", import.meta.url), join(target, "package.json"));
  }));
  try {
    const one = await import(`${pathToFileURL(join(first, "src", "child-capabilities-v1.ts")).href}?copy=1`);
    const two = await import(`${pathToFileURL(join(second, "src", "child-capabilities-v1.ts")).href}?copy=2`);
    assert.equal(one.getOrCreateChildCapabilityRegistryV1(), two.getOrCreateChildCapabilityRegistryV1());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physically separate module copies share the Process wait admission bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-wait-copies-"));
  const source = new URL("../src/", import.meta.url);
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([first, second].map(async (target) => {
    await mkdir(join(target, "src"), { recursive: true });
    await cp(source, join(target, "src"), { recursive: true });
    await cp(new URL("../package.json", import.meta.url), join(target, "package.json"));
  }));
  try {
    const one = await import(`${pathToFileURL(join(first, "src", "process-wait-bridge-v2.ts")).href}?copy=1`);
    const two = await import(`${pathToFileURL(join(second, "src", "process-wait-bridge-v2.ts")).href}?copy=2`);
    const sessionId = `copy-process-wait-${crypto.randomUUID()}`;
    const handle = one.registerProcessWaitBridgeV2({ version: 2, sessionId, captureOwnerToken: () => "process-owner-v1:copy", admitContinuation: async () => "trigger" });
    assert.equal(two.getProcessWaitBridgeV2(sessionId)?.captureOwnerToken(), "process-owner-v1:copy");
    assert.equal(await two.getProcessWaitBridgeV2(sessionId)?.admitContinuation({ admissionId: "batch-copy", ownerToken: "process-owner-v1:copy", continuationSignal: true }), "trigger");
    handle.dispose();
    assert.equal(two.getProcessWaitBridgeV2(sessionId), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incompatible child capability holder fails closed", () => {
  const script = `
    Object.defineProperty(globalThis, Symbol.for("pi.child-capability-registry.v2"), {
      value: { version: 999 }, configurable: false
    });
    import(${JSON.stringify(new URL("../src/child-capabilities-v1.ts", import.meta.url).href)})
      .then(m => m.getOrCreateChildCapabilityRegistryV1());
  `;
  const result = spawnSync(process.execPath, [
    "--import",
    new URL("./ts-resolve.mjs", import.meta.url).pathname,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    script,
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incompatible Pi child capability registry cell/);
});

test("an incompatible existing global holder fails closed", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, SYMBOL);
  if (descriptor) {
    // The singleton holder is intentionally non-configurable. A child process
    // owns the destructive incompatible-holder scenario.
    const { spawnSync } = await import("node:child_process");
    const script = `
      Object.defineProperty(globalThis, Symbol.for("pi.runtime-contracts.continuation.v1"), {
        value: { apiVersion: 999 }, configurable: false
      });
      import(${JSON.stringify(new URL("../src/continuation-v1.ts", import.meta.url).href)})
        .then(m => m.getContinuationRegistryV1());
    `;
    const result = spawnSync(process.execPath, [
      "--import",
      new URL("./ts-resolve.mjs", import.meta.url).pathname,
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime-contracts\/incompatible-registry/);
  }
});
