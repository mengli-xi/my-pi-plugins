import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test, mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { installAuthBackend, overridePlatform } from "./test/auth-backend.ts";

const backend = installAuthBackend();
const keyring = await import("./secure-keyring.ts");
const store = keyring.createSecureKeyringStore("test.auth");
let restorePlatform: (() => void) | undefined;
const disabledRecovery = process.env.PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY;

beforeEach(() => {
  backend.reset();
  delete process.env.PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY;
});
afterEach(() => {
  restorePlatform?.(); restorePlatform = undefined;
  mock.restoreAll(); syncBuiltinESMExports();
});
after(() => {
  backend.close();
  if (disabledRecovery === undefined) delete process.env.PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY;
  else process.env.PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY = disabledRecovery;
});

test("the loader intercepts createRequire's native module and isolates services", () => {
  store.write("account", "secret");
  assert.equal(store.read("account"), "secret");
  assert.equal(keyring.createSecureKeyringStore("different.service").read("account"), undefined);
  store.remove("account");
  assert.equal(store.read("account"), undefined);
  assert.ok(backend.operations.some(op => op.service === "test.auth"));
});

test("unavailable native storage fails without a memory fallback", () => {
  backend.setMode("unavailable");
  assert.throws(() => store.read("account"), /simulated secure credential store unavailable/);
  assert.throws(() => store.write("account", "secret"), /simulated secure credential store unavailable/);
  assert.throws(() => store.remove("account"), /simulated secure credential store unavailable/);
  assert.equal(backend.entries.size, 0);
});

test("native write failures stay visible to the caller", () => {
  backend.setMode("writefailing");
  assert.throws(() => store.write("account", "secret"), /simulated secure credential store write failure/);
  assert.equal(store.read("account"), undefined);
});

test("native value limits are enforced by the test backend, not a production branch", () => {
  backend.setMode("sizelimited");
  assert.throws(() => store.write("account", "x".repeat(1281)), /platform limit/);
  store.write("account", "x".repeat(1280));
  assert.equal(store.read("account")?.length, 1280);
});

test("revoked Linux keyrings recover through a mocked subprocess only", () => {
  restorePlatform = overridePlatform("linux");
  backend.setMode("keyrevoked");
  const recovered = new Map<string, string>();
  const spawn = mock.method(childProcess, "spawnSync", (command: string, args: string[], options: any) => {
    assert.equal(command, "keyctl");
    assert.deepEqual(args.slice(0, 3), ["session", "-", process.execPath]);
    const request = JSON.parse(options.input);
    assert.equal(request.service, "test.auth");
    let response: any = { ok: true };
    if (request.operation === "write") recovered.set(request.account, request.payload);
    if (request.operation === "remove") recovered.delete(request.account);
    if (request.operation === "read") response = recovered.has(request.account)
      ? { ok: true, found: true, value: recovered.get(request.account) } : { ok: true, found: false };
    return { status: 0, signal: null, stdout: JSON.stringify(response) };
  });
  syncBuiltinESMExports();
  store.write("account", "recovered-secret");
  assert.equal(store.read("account"), "recovered-secret");
  store.remove("account");
  assert.equal(store.read("account"), undefined);
  assert.equal(spawn.mock.callCount(), 4);
  assert.equal(backend.entries.size, 0);
});

for (const result of [
  { status: 1, signal: null, stdout: "" },
  { status: 0, signal: null, stdout: "not JSON" },
  { status: 0, signal: null, stdout: '{"ok":true,"found":true}' },
  { status: 0, signal: null, stdout: '{"ok":true,"found":false,"extra":true}' },
]) {
  test(`revoked keyring recovery fails closed for ${JSON.stringify(result)}`, () => {
    restorePlatform = overridePlatform("linux");
    backend.setMode("keyrevoked");
    mock.method(childProcess, "spawnSync", () => result);
    syncBuiltinESMExports();
    assert.throws(() => store.read("account"), /Linux keyring recovery failed/);
    assert.equal(backend.entries.size, 0);
  });
}

test("disabled keyring recovery does not spawn a subprocess", () => {
  restorePlatform = overridePlatform("linux");
  backend.setMode("keyrevoked");
  process.env.PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY = "1";
  const spawn = mock.method(childProcess, "spawnSync", () => { throw new Error("must not spawn"); });
  syncBuiltinESMExports();
  assert.throws(() => store.read("account"), /KeyRevoked/);
  assert.equal(spawn.mock.callCount(), 0);
});

test("production keyring exports do not expose test backends or counters", () => {
  assert.deepEqual(Object.keys(keyring), ["createSecureKeyringStore"]);
});
