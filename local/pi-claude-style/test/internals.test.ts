import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  auditInternals,
  consumeNewDrift,
  declareProbes,
  driftFingerprint,
  flushInternalsHealth,
  markBroken,
  markOk,
  renderDriftReport,
  resetInternals,
  setHealthPath,
  summariseDrift,
  type Probe,
} from "../src/internals.ts";
import { ALL_PROBES } from "../src/probes.ts";

const V = "1.0.0";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "internals-"));
  resetInternals();
  setHealthPath(join(dir, "health.json"));
});

afterEach(async () => {
  await flushInternalsHealth();
  resetInternals();
  rmSync(dir, { recursive: true, force: true });
});

const probe = (id: string, check?: () => boolean): Probe => ({
  id,
  needs: `${id} 的内部名`,
  breaks: `${id} 失效`,
  ...(check ? { check } : {}),
});

test("an eager probe whose name is gone reads as missing", () => {
  declareProbes([probe("gone", () => false), probe("here", () => true)]);
  const rows = auditInternals(V);
  assert.equal(rows.find((row) => row.id === "gone")?.state, "missing");
  assert.equal(rows.find((row) => row.id === "here")?.state, "ok");
});

test("a probe whose check throws is missing, and carries the reason", () => {
  declareProbes([
    probe("explodes", () => {
      throw new Error("boom");
    }),
  ]);
  const row = auditInternals(V)[0]!;
  assert.equal(row.state, "missing");
  assert.equal(row.detail, "boom");
});

test("an instance probe that has never run is unexercised, not ok", () => {
  declareProbes([probe("instance")]);
  assert.equal(auditInternals(V)[0]!.state, "unexercised");
});

test("markOk and markBroken move an instance probe, and persist", async () => {
  declareProbes([probe("instance")]);
  markOk("instance", V);
  assert.equal(auditInternals(V)[0]!.state, "ok");

  markBroken("instance", "字段没了", V);
  const row = auditInternals(V)[0]!;
  assert.equal(row.state, "broken");
  assert.equal(row.detail, "字段没了");

  await flushInternalsHealth();
  const stored = JSON.parse(readFileSync(join(dir, "health.json"), "utf8"));
  assert.equal(stored.version, V);
  assert.equal(stored.probes.instance.state, "broken");
});

test("an eager check overrides a stale stored ok", async () => {
  // Yesterday's session recorded a working patch; the name is gone today.
  declareProbes([probe("both", () => true)]);
  markOk("both", V);
  await flushInternalsHealth();
  resetInternals();
  setHealthPath(join(dir, "health.json"));
  declareProbes([probe("both", () => false)]);
  assert.equal(auditInternals(V)[0]!.state, "missing");
});

test("a version change discards everything recorded against the old one", () => {
  declareProbes([probe("instance")]);
  markOk("instance", V);
  assert.equal(auditInternals(V)[0]!.state, "ok");
  assert.equal(auditInternals("2.0.0")[0]!.state, "unexercised");
});

test("markOk on an already-ok probe does not rewrite the store", async () => {
  declareProbes([probe("instance")]);
  markOk("instance", V);
  await flushInternalsHealth();
  const first = readFileSync(join(dir, "health.json"), "utf8");
  markOk("instance", V);
  await flushInternalsHealth();
  markOk("instance", V);
  assert.equal(readFileSync(join(dir, "health.json"), "utf8"), first);
});

test("drift reports once per version and problem set", () => {
  declareProbes([probe("a", () => false), probe("b", () => true)]);

  const first = consumeNewDrift(V);
  assert.ok(first, "第一次应当上报");
  assert.equal(first.rows.filter((row) => row.state === "missing").length, 1);

  assert.equal(consumeNewDrift(V), undefined, "同一组问题不应重复上报");
});

test("a newly broken probe reports even though an older one already did", () => {
  declareProbes([probe("a", () => false), probe("b")]);
  assert.ok(consumeNewDrift(V));
  markBroken("b", "也坏了", V);
  assert.ok(consumeNewDrift(V), "问题集合变了，应当再报一次");
});

test("unexercised probes alone never trigger a pushed report", () => {
  declareProbes([probe("idle-1"), probe("idle-2")]);
  assert.equal(consumeNewDrift(V), undefined);
});

test("the same problem set on a new pi version reports again", () => {
  declareProbes([probe("a", () => false)]);
  assert.ok(consumeNewDrift(V));
  assert.equal(consumeNewDrift(V), undefined);
  assert.ok(consumeNewDrift("2.0.0"), "升级后应当重新确认");
});

test("the fingerprint ignores probe order and healthy probes", () => {
  const rows = auditInternals(V);
  assert.equal(driftFingerprint(rows, V), `${V}|`);

  declareProbes([probe("z", () => false), probe("a", () => false), probe("ok", () => true)]);
  assert.equal(driftFingerprint(auditInternals(V), V), `${V}|a:missing,z:missing`);
});

test("the summary counts problems and idle probes separately", () => {
  declareProbes([probe("bad", () => false), probe("idle"), probe("fine", () => true)]);
  const summary = summariseDrift(auditInternals(V), V);
  assert.match(summary, /1 处内部依赖失效/);
  assert.match(summary, /1 处未触发/);
});

test("the report names what breaks, but only for probes that are not ok", () => {
  declareProbes([probe("bad", () => false), probe("fine", () => true)]);
  const report = renderDriftReport(auditInternals(V), V);
  assert.match(report, /bad 失效/);
  assert.doesNotMatch(report, /fine 失效/);
});

test("every declared probe has a unique id and a non-empty consequence", () => {
  const seen = new Set<string>();
  for (const p of ALL_PROBES) {
    assert.ok(!seen.has(p.id), `重复的 probe id: ${p.id}`);
    seen.add(p.id);
    assert.ok(p.breaks.length > 0, `${p.id} 没有说明影响`);
    assert.ok(p.needs.length > 0, `${p.id} 没有说明依赖什么`);
  }
});

test("the real probes all pass against the installed pi", () => {
  // The offline half of `npm run check-internals`, as a test: a pi upgrade
  // that removes a patched prototype fails the suite rather than degrading
  // the transcript silently.
  declareProbes(ALL_PROBES);
  const missing = auditInternals()
    .filter((row) => row.state === "missing")
    .map((row) => `${row.id} (${row.needs})`);
  assert.deepEqual(missing, []);
});
