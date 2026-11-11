import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  applyFastTier,
  FAST_TIER,
  loadEnabled,
  restoreSessionOverride,
  saveEnabled,
  SESSION_STATE_ENTRY_TYPE,
} from "../state.ts";

const CODEX_BODY = {
  model: "gpt-5.6-sol",
  store: false,
  stream: true,
  input: [],
};

test("injects the priority tier for codex payloads when enabled", () => {
  const result = applyFastTier(CODEX_BODY, "openai-codex", true);
  assert.ok(result);
  assert.equal(result.service_tier, FAST_TIER);
  // Replacement, not mutation: the original body stays clean.
  assert.equal("service_tier" in CODEX_BODY, false);
  assert.equal(result.model, CODEX_BODY.model);
});

test("leaves the payload alone when disabled", () => {
  assert.equal(applyFastTier(CODEX_BODY, "openai-codex", false), undefined);
});

test("leaves other providers alone", () => {
  assert.equal(applyFastTier(CODEX_BODY, "anthropic", true), undefined);
  assert.equal(applyFastTier(CODEX_BODY, undefined, true), undefined);
});

test("never overrides a tier the body already names", () => {
  const body = { ...CODEX_BODY, service_tier: "default" };
  assert.equal(applyFastTier(body, "openai-codex", true), undefined);
});

test("rejects payloads that are not request bodies", () => {
  assert.equal(applyFastTier(null, "openai-codex", true), undefined);
  assert.equal(applyFastTier("body", "openai-codex", true), undefined);
  assert.equal(applyFastTier([1], "openai-codex", true), undefined);
  assert.equal(applyFastTier({ no: "model" }, "openai-codex", true), undefined);
});

const dir = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the toggle round-trips through its state file", () => {
  const path = join(dir, "pi-fast.json");
  assert.equal(loadEnabled(path), false); // missing file
  saveEnabled(path, true);
  assert.equal(loadEnabled(path), true);
  saveEnabled(path, false);
  assert.equal(loadEnabled(path), false);
});

test("a corrupt state file reads as off", () => {
  const path = join(dir, "corrupt.json");
  saveEnabled(path, true);
  assert.equal(loadEnabled(path), true);
  writeFileSync(path, "{not json", "utf8");
  assert.equal(loadEnabled(path), false);
});

// The atomic replace renames over the target, so the target's own mode is not
// what stops the write; a read-only directory keeps the temporary file from
// being created. chmod does not stop root either way.
test("a failed write leaves the previous default intact", { skip: process.getuid?.() === 0 }, () => {
  const directory = join(dir, "read-only");
  mkdirSync(directory);
  const path = join(directory, "pi-fast.json");
  saveEnabled(path, true);
  const previous = readFileSync(path, "utf8");
  chmodSync(directory, 0o555);
  try {
    assert.throws(() => saveEnabled(path, false), /EACCES|EPERM/);
    assert.equal(readFileSync(path, "utf8"), previous, "the old bytes survive a failed replace");
    assert.equal(loadEnabled(path), true);
    assert.deepEqual(readdirSync(directory), ["pi-fast.json"], "no temporary file is left behind");
  } finally {
    chmodSync(directory, 0o755);
  }
});

function customState(id: string, enabled: unknown): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: SESSION_STATE_ENTRY_TYPE,
    data: { enabled },
  };
}

test("restores the newest valid fast override from a branch", () => {
  const entries = [
    customState("on", true),
    customState("malformed", "yes"),
    customState("off", false),
  ];
  assert.equal(restoreSessionOverride(entries), false);
});

test("a branch clear marker restores follow-global state", () => {
  const entries = [customState("off", false), customState("clear", null)];
  assert.equal(restoreSessionOverride(entries), undefined);
});
