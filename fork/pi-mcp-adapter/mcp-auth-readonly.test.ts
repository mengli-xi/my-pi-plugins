import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test, mock } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { installAuthBackend, overridePlatform } from "./test/auth-backend.ts";

const backend = installAuthBackend();
const auth = await import("./mcp-auth.ts");
const url = "https://example.com/mcp";
const service = "pi-mcp-adapter.oauth";
const account = (name: string) => `sha256-${createHash("sha256").update(name).digest("hex")}`;
const entry = (token = "secret") => ({ serverUrl: url, tokens: { accessToken: token } });
let directory: string;
let restorePlatform: (() => void) | undefined;
const originalEnv = Object.fromEntries(["MCP_OAUTH_DIR", "PI_MCP_ADAPTER_DISABLE_AUTH_CACHE", "PI_PACKAGE_DIR"].map(name => [name, process.env[name]]));

beforeEach(() => {
  delete process.env.MCP_OAUTH_DIR;
  delete process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
  delete process.env.PI_PACKAGE_DIR;
  directory = mkdtempSync(join(tmpdir(), "mcp-auth-readonly-"));
  backend.reset();
  auth.resetAuthEntryCache();
});
afterEach(() => {
  restorePlatform?.();
  restorePlatform = undefined;
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(directory, { recursive: true, force: true });
});
after(() => {
  backend.close();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function legacy(name: string, value = entry()) {
  const path = auth.getAuthEntryFilePath(name, { baseDir: directory });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function seed(name: string, value = entry()) {
  backend.entries.set(backend.key(service, account(name)), JSON.stringify(value));
}

test("status-only inspection preserves legacy bytes when secure credentials already exist", () => {
  seed("existing");
  const path = legacy("existing", entry("legacy-secret"));
  const before = readFileSync(path);
  assert.deepEqual(auth.inspectAuthForUrl("existing", url, { baseDir: directory }), { status: "present", entry: entry() });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(backend.operations.map(op => op.operation), ["read"]);
});

test("status-only inspection reads legacy credentials without importing or removing them", () => {
  const path = legacy("legacy");
  const before = readFileSync(path);
  assert.equal(auth.inspectAuthForUrl("legacy", url, { baseDir: directory }).status, "present");
  assert.deepEqual(readFileSync(path), before);
  assert.equal(backend.entries.size, 0);
  assert.deepEqual(backend.operations.map(op => op.operation), ["read"]);
});

test("ordinary reads still migrate legacy credentials and remove the plaintext source", () => {
  const path = legacy("migrate");
  assert.deepEqual(auth.getAuthEntry("migrate", { baseDir: directory }), entry());
  assert.equal(existsSync(path), false);
  assert.deepEqual(JSON.parse(backend.entries.get(backend.key(service, account("migrate")))!), entry());
  assert.ok(backend.operations.some(op => op.operation === "write"));
});

test("ordinary secure reads still remove stale legacy credentials", () => {
  seed("stale");
  const path = legacy("stale", entry("old"));
  assert.deepEqual(auth.getAuthEntry("stale", { baseDir: directory }), entry());
  assert.equal(existsSync(path), false);
});

test("inspection bypasses a warm credential cache and observes external removal", () => {
  auth.saveAuthEntry("cached", entry(), url, { baseDir: directory });
  backend.entries.clear();
  assert.deepEqual(auth.getAuthEntry("cached", { baseDir: directory }), entry());
  assert.deepEqual(auth.inspectAuthForUrl("cached", url, { baseDir: directory }), { status: "absent" });
});

test("inspection rejects credentials for the previous URL without deleting either store", () => {
  seed("changed");
  const path = legacy("changed");
  assert.deepEqual(auth.inspectAuthForUrl("changed", "https://other.example/mcp", { baseDir: directory }), { status: "absent" });
  assert.ok(existsSync(path));
  assert.equal(backend.entries.size, 1);
  assert.deepEqual(backend.operations.map(op => op.operation), ["read"]);
});

for (const mode of ["unavailable", "keyrevoked"]) {
  test(`inspection fails closed for ${mode}, including with warm cache and legacy data`, () => {
    restorePlatform = overridePlatform("linux");
    auth.saveAuthEntry(mode, entry(), url, { baseDir: directory });
    const path = legacy(mode);
    const before = readFileSync(path);
    backend.operations.length = 0;
    backend.setMode(mode);
    const spawn = mock.method(childProcess, "spawnSync", () => { throw new Error("status inspection must not start keyctl"); });
    syncBuiltinESMExports();
    assert.equal(auth.inspectAuthForUrl(mode, url, { baseDir: directory }).status, "unavailable");
    assert.equal(spawn.mock.callCount(), 0);
    assert.deepEqual(readFileSync(path), before);
    assert.ok(backend.operations.every(op => op.operation === "read"));
  });
}

test("fake write failures surface the real secure-store error and retain legacy data", () => {
  const path = legacy("write-fail");
  backend.setMode("writefailing");
  assert.throws(() => auth.getAuthEntry("write-fail", { baseDir: directory }), auth.OAuthCredentialStoreError);
  assert.ok(existsSync(path));
  assert.equal(backend.entries.size, 0);
});

test("the Windows-sized fake backend exercises chunking without a production switch", () => {
  restorePlatform = overridePlatform("win32");
  backend.setMode("sizelimited");
  const value = entry("x".repeat(5000));
  auth.saveAuthEntry("chunked", value, url, { baseDir: directory });
  assert.ok(backend.entries.size > 1);
  assert.ok([...backend.entries.values()].every(payload => payload.length <= 1280));
  backend.operations.length = 0;
  const path = legacy("chunked");
  assert.deepEqual(auth.inspectAuthForUrl("chunked", url, { baseDir: directory }), { status: "present", entry: value });
  assert.ok(existsSync(path));
  assert.ok(backend.operations.every(op => op.operation === "read"));
  auth.clearAllCredentials("chunked", { baseDir: directory });
  assert.equal(backend.entries.size, 0);
});

test("read-only chunk inspection does not compact records on a different platform", () => {
  restorePlatform = overridePlatform("win32");
  auth.saveAuthEntry("cross-platform", entry("x".repeat(3000)), url, { baseDir: directory });
  restorePlatform();
  restorePlatform = overridePlatform("linux");
  const before = [...backend.entries];
  backend.operations.length = 0;
  assert.equal(auth.inspectAuthForUrl("cross-platform", url, { baseDir: directory }).status, "present");
  assert.deepEqual([...backend.entries], before);
  assert.ok(backend.operations.every(op => op.operation === "read"));
  auth.resetAuthEntryCache();
  auth.getAuthEntry("cross-platform", { baseDir: directory });
  assert.equal(backend.entries.size, 1);
});

test("malformed credentials are never reported as a successful inspection", () => {
  backend.entries.set(backend.key(service, account("corrupt")), "not JSON");
  assert.throws(() => auth.inspectAuthForUrl("corrupt", url, { baseDir: directory }), /Failed to parse OAuth credentials/);
  assert.ok(backend.operations.every(op => op.operation === "read"));
});

test("encrypted-file status inspection observes disk changes without modifying its bytes", () => {
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, key: process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = Buffer.alloc(32, 7).toString("base64");
  const options = { credentialStore: "encrypted-file" as const };
  try {
    auth.saveAuthEntry("encrypted", entry(), url, options);
    const path = join(directory, "mcp-oauth-encrypted", account("encrypted"), "credentials.json");
    const before = readFileSync(path);
    assert.equal(auth.inspectAuthForUrl("encrypted", url, options).status, "present");
    assert.deepEqual(readFileSync(path), before);
    rmSync(path);
    assert.equal(auth.inspectAuthForUrl("encrypted", url, options).status, "absent");
    assert.equal(backend.operations.length, 0);
  } finally {
    for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.agent], ["PI_MCP_ADAPTER_OAUTH_FILE_KEY", previous.key]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});

test("production auth exports do not expose test backends or counters", () => {
  assert.deepEqual(Object.keys(auth).filter(name => /Test/.test(name)), []);
});
