import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("isolated profile preparation writes only stock Pi compaction settings", (t) => {
  const agent = mkdtempSync(join(tmpdir(), "compact-profile-"));
  t.after(() => rmSync(agent, { recursive: true, force: true }));
  const settingsPath = join(agent, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ sentinel: true, compaction: { reserveTokens: 123, modelOverrides: { "other/model": { reserveTokens: 456 } } } }));
  const output = execFileSync(process.execPath, [new URL("../scripts/prepare-profile.mjs", import.meta.url).pathname,
    "--agent-dir", agent, "--models", JSON.stringify({ "fixture/main": 128000 }), "--keep-recent", "12000"], { encoding: "utf8" });
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.sentinel, true);
  assert.equal(settings.compaction.enabled, true);
  assert.equal(settings.compaction.reserveTokens, 123);
  assert.deepEqual(settings.compaction.modelOverrides, { "other/model": { reserveTokens: 456 }, "fixture/main": { reserveTokens: 12800, keepRecentTokens: 12000 } });
  assert.deepEqual(readdirSync(agent), ["settings.json"], "no retired package configuration is read or created");
  assert.equal(JSON.parse(output).restartRequired, true);
});
