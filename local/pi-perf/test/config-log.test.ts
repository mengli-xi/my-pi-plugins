import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PerfConfig, sampleInterval, sampleThreshold } from "../src/config.ts";
import { JsonlWriter } from "../src/log-writer.ts";

test("invalid timer inputs fall back; every legal value is preserved", () => {
  for (const raw of [undefined, "", " ", "NaN", "bad", "-1", "0", "0.5", "Infinity", "2147483648", "1e100"]) assert.equal(sampleInterval(raw), 60_000, String(raw));
  for (const raw of ["1", "1.5", "10000", "2147483647"]) assert.equal(sampleInterval(raw), Number(raw));
  assert.equal(sampleInterval("bad", 10_000), 10_000);
});
test("configuration defaults on, persists off, preserves unknown fields, rejects external changes and damaged stores", () => {
  const root = mkdtempSync(join(tmpdir(), "perf-config-"));
  try {
    const a = new PerfConfig(root); assert.equal(a.enabled, true);
    a.setEnabled(false); assert.equal(new PerfConfig(root).enabled, false);
    const b = new PerfConfig(root); a.setEnabled(true);
    assert.throws(() => b.setEnabled(true), /changed in another process/);
    const value = JSON.parse(readFileSync(a.path, "utf8")); value.unknown = "keep"; value.overrides.future = 1;
    writeFileSync(a.path, JSON.stringify(value)); new PerfConfig(root).setEnabled(false);
    assert.equal(JSON.parse(readFileSync(a.path, "utf8")).unknown, "keep");
    writeFileSync(a.path, "broken"); const broken = new PerfConfig(root);
    assert.equal(broken.enabled, false); assert.match(broken.error!, /config unavailable/);
    assert.throws(() => broken.setEnabled(true)); assert.equal(readFileSync(a.path, "utf8"), "broken");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("JSONL flush retains the cause of failure until a successful write", async () => {
  const root = mkdtempSync(join(tmpdir(), "perf-log-"));
  try {
    const path = join(root, "block"); writeFileSync(path, "file");
    const writer = new JsonlWriter(join(path, "log.jsonl"));
    writer.write({ sample: 1 }); await assert.doesNotReject(writer.flush());
    assert.match(writer.error!, /log write failed: E/);
    rmSync(path); mkdirSync(path); writer.write({ sample: 2 }); await writer.flush();
    assert.equal(JSON.parse(readFileSync(join(path, "log.jsonl"), "utf8")).sample, 2);
    assert.equal(writer.error, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("thresholds retain zero and fractional values while timers still reject zero", () => {
  for (const raw of ["0", "0.5", "50", "2147483647"]) assert.equal(sampleThreshold(raw, 50), Number(raw));
  for (const raw of [undefined, "", " ", "-1", "NaN", "Infinity", "2147483648"]) assert.equal(sampleThreshold(raw, 50), 50);
  assert.equal(sampleInterval("0", 10000), 10000);
});
