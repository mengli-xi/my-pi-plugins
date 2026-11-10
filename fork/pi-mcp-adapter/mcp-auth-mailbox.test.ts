import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test, mock } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { installAuthBackend } from "./test/auth-backend.ts";

const backend = installAuthBackend();
const bindingKey = Symbol.for("pi-mcp-adapter.test.mailbox-binding");
let producer: any;
(globalThis as any)[bindingKey] = {
  registerProducer(value: unknown) { producer = value; return {}; }, close() {},
};
const fixtureUrl = new URL("./test/auth-mailbox-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "pi-session-inject/mailbox-v1/light") return { url: fixtureUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === fixtureUrl) return {
      format: "module", shortCircuit: true,
      source: 'export function bindMailbox() { return globalThis[Symbol.for("pi-mcp-adapter.test.mailbox-binding")]; }',
    };
    return nextLoad(url, context);
  },
});
const { createMcpMailbox } = await import("./mailbox.ts");
const auth = await import("./mcp-auth.ts");
const url = "https://example.com/mcp";
const account = `sha256-${createHash("sha256").update("server").digest("hex")}`;
const backendKey = backend.key("pi-mcp-adapter.oauth", account);
let directory: string;
let state: any;
let prohibitedCalls: string[];
const originalOAuthDir = process.env.MCP_OAUTH_DIR;
const originalCache = process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mcp-auth-mailbox-"));
  delete process.env.MCP_OAUTH_DIR;
  delete process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
  backend.reset();
  auth.resetAuthEntryCache();
  state = {
    owner: { isActive: () => true }, config: { mcpServers: { server: { url } } },
    consentManager: { isDenied: () => false }, authStorageOptions: { baseDir: directory },
  };
  createMcpMailbox({ on: () => () => {} } as any, () => state);
  prohibitedCalls = [];
  mock.method(globalThis, "fetch", () => { prohibitedCalls.push("fetch"); throw new Error("OAuth mail validation must not contact a provider or MCP server"); });
  mock.method(childProcess, "spawnSync", () => { prohibitedCalls.push("spawnSync"); throw new Error("OAuth mail validation must not start keyctl or a browser"); });
  mock.method(childProcess, "spawn", () => { prohibitedCalls.push("spawn"); throw new Error("OAuth mail validation must not start a process"); });
  syncBuiltinESMExports();
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(prohibitedCalls, [], "mail validation must remain read-only and offline");
});
after(() => {
  backend.close(); hooks.deregister(); delete (globalThis as any)[bindingKey];
  for (const [name, value] of [["MCP_OAUTH_DIR", originalOAuthDir], ["PI_MCP_ADAPTER_DISABLE_AUTH_CACHE", originalCache]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
});
function seed(tokens: any = { accessToken: "secret" }, serverUrl = url) {
  backend.entries.set(backendKey, JSON.stringify({ serverUrl, tokens }));
}
function check() {
  return producer.checkCurrent({ messages: [{ customType: "mcp-oauth-status", details: { server: "server", status: "authenticated", deliveryId: "oauth:server:attempt:authenticated" } }] }, "before-project", {});
}

test("authenticated mail validates current persistent credentials without writes", async () => {
  seed();
  assert.deepEqual(await check(), { kind: "allow", project: true, wake: true });
  assert.deepEqual(backend.operations.map(op => op.operation), ["read"]);
});

test("authenticated mail cannot use a warm cache after external logout", async () => {
  auth.saveAuthEntry("server", { tokens: { accessToken: "cached" } }, url, state.authStorageOptions);
  backend.entries.clear();
  backend.operations.length = 0;
  assert.equal((await check()).kind, "cancel");
  assert.deepEqual(backend.operations.map(op => op.operation), ["read"]);
});

test("authenticated mail rechecks the current configured URL", async () => {
  seed();
  state.config.mcpServers.server.url = "https://changed.example/mcp";
  assert.equal((await check()).kind, "cancel");
  assert.equal(backend.entries.size, 1);
});

test("authenticated mail resolves URL environment variables at delivery time", async () => {
  const previous = process.env.MCP_AUTH_TEST_URL;
  state.config.mcpServers.server.url = "${MCP_AUTH_TEST_URL}";
  try {
    process.env.MCP_AUTH_TEST_URL = url;
    seed();
    assert.equal((await check()).kind, "allow");
    process.env.MCP_AUTH_TEST_URL = "https://changed.example/mcp";
    assert.equal((await check()).kind, "cancel");
    delete process.env.MCP_AUTH_TEST_URL;
    assert.equal((await check()).kind, "hold");
  } finally {
    if (previous === undefined) delete process.env.MCP_AUTH_TEST_URL; else process.env.MCP_AUTH_TEST_URL = previous;
  }
});

for (const serverUrl of [undefined, "not a URL"]) {
  test(`authenticated mail is held when the current URL is ${String(serverUrl)}`, async () => {
    seed(); state.config.mcpServers.server.url = serverUrl;
    assert.equal((await check()).kind, "hold");
    assert.equal(backend.operations.length, 0);
  });
}

for (const mode of ["unavailable", "keyrevoked"]) {
  test(`authenticated mail is held rather than accepted for a ${mode} store`, async () => {
    auth.saveAuthEntry("server", { tokens: { accessToken: "cached" } }, url, state.authStorageOptions);
    backend.setMode(mode);
    assert.equal((await check()).kind, "hold");
  });
}

for (const tokens of [undefined, { accessToken: "" }, { accessToken: "expired", refreshToken: "must-not-refresh", expiresAt: 1 }]) {
  test(`authenticated mail cancels missing or expired tokens: ${JSON.stringify(tokens)}`, async () => {
    backend.entries.set(backendKey, JSON.stringify({ serverUrl: url, tokens }));
    assert.equal((await check()).kind, "cancel");
    assert.ok(backend.operations.every(op => op.operation === "read"));
  });
}

test("corrupt credentials hold mail instead of claiming success", async () => {
  backend.entries.set(backendKey, "not JSON");
  assert.equal((await check()).kind, "hold");
});

test("authenticated mail does not migrate or delete plaintext credentials", async () => {
  seed();
  const path = auth.getAuthEntryFilePath("server", state.authStorageOptions);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ serverUrl: url, tokens: { accessToken: "legacy" } }));
  const before = readFileSync(path);
  assert.equal((await check()).kind, "allow");
  assert.deepEqual(readFileSync(path), before);
  backend.entries.clear();
  assert.equal((await check()).kind, "allow");
  assert.ok(existsSync(path));
  assert.equal(backend.entries.size, 0);
  assert.ok(backend.operations.every(op => op.operation === "read"));
});

test("owner retirement during a cold auth import holds mail before reading credentials", async () => {
  seed();
  const pending = check();
  await Promise.resolve();
  state.owner.isActive = () => false;
  assert.equal((await pending).kind, "hold");
  assert.equal(backend.operations.length, 0);
});

test("disabled, unapproved, or retired servers cannot accept authenticated mail", async () => {
  seed(); state.config.mcpServers.server.disabled = true;
  assert.equal((await check()).kind, "hold");
  state.config.mcpServers.server.disabled = false;
  state.blockedProjectServers = new Set(["server"]);
  assert.equal((await check()).kind, "hold");
  state.blockedProjectServers.clear(); state.owner.isActive = () => false;
  assert.equal((await check()).kind, "hold");
  assert.equal(backend.operations.length, 0);
});
