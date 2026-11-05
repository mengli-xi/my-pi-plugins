import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, SessionNamingConfigService } from "../src/config.ts";

async function temporary(run: (agentDir: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-naming-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("defaults, validation, reset and revision are conf-owned", () => temporary((agentDir) => {
  const service = new SessionNamingConfigService({ agentDir });
  assert.deepEqual(service.active, DEFAULT_CONFIG);
  service.set("model", "provider-a/test-model");
  service.set("maxChars", 32);
  assert.equal(service.active.model, "provider-a/test-model");
  assert.equal(service.active.maxChars, 32);
  assert.equal(service.revision, 2);
  assert.throws(() => service.set("effort", "impossible"), /expects one of/);
  assert.throws(() => service.set("maxChars", 7), /8\.\.64/);
  assert.throws(() => service.set("timeoutMs", 999), /1000\.\.60000/);
  assert.throws(() => service.set("maxOutputTokens", 16), /32\.\.2048/);
  service.reset("model");
  assert.equal(service.active.model, "session");
}));

test("migrates schema v1 by removing the retired border setting", () => temporary((agentDir) => {
  const cwd = join(agentDir, "extensions", "pi-session-naming");
  mkdirSync(cwd, { recursive: true });
  const path = join(cwd, "config.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    revision: 3,
    overrides: {
      model: "provider-a/test",
      showInEditorBorder: false,
    },
  }));

  const service = new SessionNamingConfigService({ agentDir });
  assert.equal(service.active.model, "provider-a/test");
  assert.equal(service.revision, 3);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.overrides, { model: "provider-a/test" });
}));

test("migrates the former CC Style override from a schema backup", () => temporary((agentDir) => {
  const core = join(agentDir, "extensions", "pi-claude-style");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "config.json"), JSON.stringify({
    schemaVersion: 3,
    revision: 5,
    overrides: {},
  }));
  const source = JSON.stringify({
    schemaVersion: 2,
    revision: 4,
    overrides: {
      transcript: {
        sessionNaming: {
          enabled: false,
          model: "provider-a/migrated",
          effort: "low",
          maxChars: 31,
          showInEditorBorder: false,
        },
      },
    },
  });
  const sourcePath = join(core, "config.json.schema-v2.bak");
  writeFileSync(sourcePath, source);

  const first = new SessionNamingConfigService({
    agentDir,
    now: () => new Date("2026-08-11T01:02:03Z"),
  });
  assert.deepEqual(first.active, {
    enabled: false,
    model: "provider-a/migrated",
    effort: "low",
    maxChars: 31,
    timeoutMs: DEFAULT_CONFIG.timeoutMs,
    maxOutputTokens: DEFAULT_CONFIG.maxOutputTokens,
  });
  assert.equal(first.migration?.sourcePath, sourcePath);
  assert.match(first.migration?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(sourcePath, "utf8"), source, "source remains read-only");

  writeFileSync(sourcePath, source.replace("migrated", "changed-later"));
  const second = new SessionNamingConfigService({ agentDir });
  assert.equal(second.active.model, "provider-a/migrated", "target store is idempotent");
}));

test("schema v2 rejects the retired border field instead of keeping a dead setting", () => temporary((agentDir) => {
  const cwd = join(agentDir, "extensions", "pi-session-naming");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "config.json"), JSON.stringify({
    schemaVersion: 2,
    revision: 0,
    overrides: { showInEditorBorder: true },
  }));
  const service = new SessionNamingConfigService({ agentDir });
  assert.match(service.degradedError ?? "", /invalid fields/);
}));

test("invalid legacy fields are skipped without poisoning valid ones", () => temporary((agentDir) => {
  const core = join(agentDir, "extensions", "pi-claude-style");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "config.json"), JSON.stringify({
    schemaVersion: 2,
    revision: 1,
    overrides: {
      transcript: {
        sessionNaming: { model: "provider-a/valid", effort: "wild", maxChars: 1 },
      },
    },
  }));
  const service = new SessionNamingConfigService({ agentDir });
  assert.equal(service.active.model, "provider-a/valid");
  assert.equal(service.active.effort, DEFAULT_CONFIG.effort);
  assert.equal(service.active.maxChars, DEFAULT_CONFIG.maxChars);
}));

test("a corrupt target is preserved and becomes recoverably read-only", () => temporary((agentDir) => {
  const directory = join(agentDir, "extensions", "pi-session-naming");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "config.json");
  const bytes = "{ broken\n";
  writeFileSync(path, bytes);
  const service = new SessionNamingConfigService({
    agentDir,
    now: () => new Date("2026-08-11T01:02:03.004Z"),
  });
  assert.ok(service.degradedError);
  assert.equal(service.active.enabled, false, "a corrupt store must not enable a model request");
  assert.throws(() => service.set("enabled", false), /read-only/);
  assert.equal(readFileSync(path, "utf8"), bytes);
  const backup = service.recoverResetAll();
  assert.equal(backup, `${path}.invalid-2026-08-11T01-02-03-004Z.bak`);
  assert.equal(readFileSync(backup!, "utf8"), bytes);
  assert.deepEqual(service.active, DEFAULT_CONFIG);
}));
