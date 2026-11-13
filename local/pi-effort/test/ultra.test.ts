import { after } from "node:test";
import { rmSync as removeFixtures } from "node:fs";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_ULTRA_PROMPT,
  loadUltraPrompt,
  readUltraConfig,
  restoreUltra,
  subagentPackageEnabled,
  ULTRA_STATE_ENTRY_TYPE,
  ultraGate,
} from "../ultra.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "test-fixtures-"));
after(() => removeFixtures(fixtureRoot, { recursive: true, force: true }));

const CONFIG = { subagentTool: "spawn_agent", subagentPackage: "local/pi-subagents" };

test("missing config uses defaults, valid overrides apply, and invalid JSON fails closed", () => {
  const dir = mkdtempSync(join(fixtureRoot, "ultra-"));
  assert.equal(readUltraConfig(dir).subagentTool, "spawn_agent");
  assert.equal(readUltraConfig(dir).subagentPackage, undefined);

  writeFileSync(join(dir, "pi-effort.json"),
    JSON.stringify({ ultra: { subagentTool: "agent", subagentPackage: "npm:x" } }));
  assert.deepEqual(readUltraConfig(dir), { subagentTool: "agent", subagentPackage: "npm:x" });

  writeFileSync(join(dir, "pi-effort.json"), "{ not json");
  assert.throws(() => readUltraConfig(dir), /Invalid JSON/);
});

test("prompt text comes from the override file when present", () => {
  const dir = mkdtempSync(join(fixtureRoot, "ultra-"));
  assert.equal(loadUltraPrompt(dir), DEFAULT_ULTRA_PROMPT);
  writeFileSync(join(dir, "ultra-prompt.md"), "\n  delegate boldly \n");
  assert.equal(loadUltraPrompt(dir), "delegate boldly");
  writeFileSync(join(dir, "ultra-prompt.md"), "   \n");
  assert.equal(loadUltraPrompt(dir), DEFAULT_ULTRA_PROMPT, "empty override falls back");
});

test("the session flag is the latest entry on the branch", () => {
  const entry = (enabled: boolean) => ({
    type: "custom", customType: ULTRA_STATE_ENTRY_TYPE, data: { enabled },
  });
  assert.equal(restoreUltra([]), false);
  assert.equal(restoreUltra([entry(true)]), true);
  assert.equal(restoreUltra([entry(true), entry(false)]), false);
  assert.equal(restoreUltra([entry(false), entry(true)]), true);
  assert.equal(restoreUltra([{ type: "message" }, entry(true)]), true);
  assert.equal(restoreUltra([{ type: "custom", customType: "other", data: { enabled: true } }]), false);
});

test("the gate refuses to inject without the configured sub-agent tool", () => {
  const text = "delegate";
  assert.deepEqual(
    ultraGate({ enabled: true, selectedTools: ["read", "spawn_agent"], config: CONFIG, text }),
    { inject: true, text },
  );
  assert.deepEqual(
    ultraGate({ enabled: true, selectedTools: ["read", "bash"], config: CONFIG, text }),
    { inject: false, reason: "missing-tool" },
  );
  assert.deepEqual(
    ultraGate({ enabled: false, selectedTools: ["spawn_agent"], config: CONFIG, text }),
    { inject: false, reason: "off" },
  );
  for (const tools of [undefined, null, "spawn_agent", ["spawn_agent", 1]]) {
    assert.deepEqual(
      ultraGate({ enabled: true, selectedTools: tools as unknown as string[], config: CONFIG, text }),
      { inject: false, reason: "missing-tool" },
    );
  }
});

test("the default delegation prompt preserves user instructions and permissions", () => {
  assert.match(DEFAULT_ULTRA_PROMPT, /user instructions/);
  assert.match(DEFAULT_ULTRA_PROMPT, /permissions/);
  assert.doesNotMatch(DEFAULT_ULTRA_PROMPT, /no longer applies/);
});

test("unchanged files reuse bytes and parsed results, and replacement refreshes them", (t) => {
  const dir = mkdtempSync(join(fixtureRoot, "ultra-cache-"));
  const configPath = join(dir, "pi-effort.json");
  const promptPath = join(dir, "ultra-prompt.md");
  const settingsPath = join(dir, "settings.json");
  const configBytes = JSON.stringify({ ultra: { subagentTool: "agent" } });
  const settingsBytes = JSON.stringify({ packages: ["/x/local/pi-subagents"] });
  writeFileSync(configPath, configBytes);
  writeFileSync(promptPath, "delegate carefully");
  writeFileSync(settingsPath, settingsBytes);
  const read = fs.readFileSync;
  const parse = JSON.parse;
  let reads = 0;
  let parses = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if ([configPath, promptPath, settingsPath].includes(String(args[0]))) reads++;
    return Reflect.apply(read, fs, args);
  });
  t.mock.method(JSON, "parse", (...args: Parameters<typeof parse>) => {
    if (args[0] === configBytes || args[0] === settingsBytes) parses++;
    return Reflect.apply(parse, JSON, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(readUltraConfig(dir).subagentTool, "agent");
    assert.equal(loadUltraPrompt(dir), "delegate carefully");
    assert.equal(subagentPackageEnabled(dir, CONFIG), true);
  }
  assert.equal(reads, 3);
  assert.equal(parses, 2);
  const config = readUltraConfig(dir);
  config.subagentTool = "mutated";
  assert.equal(readUltraConfig(dir).subagentTool, "agent", "cache is not exposed to caller mutation");
  writeFileSync(join(dir, "replacement"), JSON.stringify({ ultra: { subagentTool: "worker" } }));
  renameSync(join(dir, "replacement"), configPath);
  assert.equal(readUltraConfig(dir).subagentTool, "worker");
  rmSync(promptPath);
  assert.equal(loadUltraPrompt(dir), DEFAULT_ULTRA_PROMPT);
  writeFileSync(promptPath, "new prompt");
  assert.equal(loadUltraPrompt(dir), "new prompt");
});

test("invalid versions cache a safe error and recover after edits", (t) => {
  const dir = mkdtempSync(join(fixtureRoot, "ultra-errors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-effort.json");
  writeFileSync(path, '{"private-marker": invalid}');
  assert.throws(() => readUltraConfig(dir));
  let error: unknown;
  try { readUltraConfig(dir); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error);
  assert.match(error.message, /pi-effort\.json.*Invalid JSON/);
  assert.doesNotMatch(error.message, /private-marker/);
  const cached = error;
  try { readUltraConfig(dir); } catch (caught) { error = caught; }
  assert.equal(error, cached);
  writeFileSync(path, JSON.stringify({ ultra: { subagentTool: 42 } }));
  assert.throws(() => readUltraConfig(dir), /ultra\.subagentTool/);
  writeFileSync(path, JSON.stringify({ ultra: { subagentTool: "worker" } }));
  assert.equal(readUltraConfig(dir).subagentTool, "worker");
  mkdirSync(join(dir, "ultra-prompt.md"));
  assert.throws(() => loadUltraPrompt(dir), /ultra-prompt\.md.*EISDIR/);
  rmSync(join(dir, "ultra-prompt.md"), { recursive: true });
  assert.equal(loadUltraPrompt(dir), DEFAULT_ULTRA_PROMPT);
  const another = mkdtempSync(join(fixtureRoot, "ultra-other-"));
  t.after(() => rmSync(another, { recursive: true, force: true }));
  assert.equal(readUltraConfig(another).subagentTool, "spawn_agent", "agent directory identities do not share config");
});

test("the settings check answers only when it can", () => {
  const dir = mkdtempSync(join(fixtureRoot, "ultra-"));
  assert.equal(subagentPackageEnabled(dir, { subagentTool: "spawn_agent" }), undefined,
    "no package configured");
  assert.equal(subagentPackageEnabled(dir, CONFIG), undefined, "settings unreadable");

  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["/x/local/pi-todo"] }));
  assert.equal(subagentPackageEnabled(dir, CONFIG), false);

  writeFileSync(join(dir, "settings.json"),
    JSON.stringify({ packages: ["/x/local/pi-subagents"] }));
  assert.equal(subagentPackageEnabled(dir, CONFIG), true);

  writeFileSync(join(dir, "settings.json"),
    JSON.stringify({ packages: [{ source: "/x/local/pi-subagents", autoload: false }] }));
  assert.equal(subagentPackageEnabled(dir, CONFIG), false, "present but not autoloaded");
});
