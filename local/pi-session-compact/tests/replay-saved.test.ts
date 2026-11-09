import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createInitialSystemMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { collectUserQuotations, renderUserQuotations } from "../src/quotations.ts";
import { collectInventory, renderInventory } from "../src/inventory.ts";
import { restoredContext } from "../src/recovery.ts";

const script = fileURLToPath(new URL("../scripts/replay-saved.mjs", import.meta.url));
const resolver = fileURLToPath(new URL("../../pi-session-inject/test/ts-resolve.mjs", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "compact-replay-")), input = join(root, "copies"), output = join(root, "output");
  mkdirSync(join(input, "sessions"), { recursive: true }); mkdirSync(join(input, "runs"));
  const cwd = "/offline/copied-project", body = "普通 Markdown 交接", timestamp = "2026-10-27T00:00:00.000Z";
  const branch: any[] = [
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "不要发布", timestamp: 1 } },
    { type: "message", id: "read", parentId: "user", timestamp, message: fauxAssistantMessage([{ type: "toolCall", id: "read-call", name: "read", arguments: { path: `${cwd}/src/a.ts` } }], { stopReason: "toolUse" }) },
    { type: "message", id: "tail", parentId: "read", timestamp, message: { role: "user", content: "tail", timestamp: 2 } },
  ];
  const quotations = renderUserQuotations(collectUserQuotations(branch, "tail")), inventory = renderInventory(collectInventory(branch, "tail", cwd));
  const appendix = "\n\n## 压缩恢复内容\n\n### pi-session-compact (pi-session-compact:recovery-v1)\n\nACTUAL_COMPACT_BODY\n\n### pi-skills (pi-skills:compact-restored-v1)\n\nACTUAL_SKILL_BODY";
  const committed: any = { type: "compaction", id: "committed", parentId: "tail", timestamp, summary: body + quotations + inventory + appendix, firstKeptEntryId: "tail", tokensBefore: 1234, systemMessage: createInitialSystemMessage("COPIED_SYSTEM", []), details: { operationId: "operation", generator: "pi-session-compact", handoff: body, recovery: { version: 1, items: [{ owner: "pi-session-compact", customType: "pi-session-compact:recovery-v1", identity: { operationId: "operation" } }, { owner: "pi-skills", customType: "pi-skills:compact-restored-v1", identity: { operationId: "operation" } }] } } };
  const header: any = { type: "session", id: "session", cwd };
  const entries: any[] = [...branch, committed];
  const run: any = { operationId: "operation", sessionId: "session", inputFingerprint: { branchLeaf: "tail", firstKeptEntryId: "tail", skillRefs: [{ sourceEntryId: "binding", name: "skill", path: "/offline/skill/SKILL.md", contentHash: "hash" }] }, threshold: { contextWindow: 200000, effectiveWindow: 100000, reserveTokens: 1111 }, outputs: { main: { requestedModel: "fake/main", rawOutput: body, attempts: [{ phase: "main", rawOutput: body, stopReason: "stop" }] } }, contextSizes: { before: {}, after: { estimated: { otherInjected: 73 } } } };
  const execute = (outputPath = output) => {
    const sessionText = [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n", runText = JSON.stringify(run);
    writeFileSync(join(input, "sessions/copy.jsonl"), sessionText); writeFileSync(join(input, "runs/run.json"), runText);
    const result = spawnSync(process.execPath, ["--import", resolver, "--experimental-strip-types", script, input, outputPath], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "isolated-agent") } });
    assert.equal(readFileSync(join(input, "sessions/copy.jsonl"), "utf8"), sessionText);
    assert.equal(readFileSync(join(input, "runs/run.json"), "utf8"), runText);
    return result;
  };
  return { root, input, output, body, branch, committed, header, entries, run, quotations, inventory, appendix, execute, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function replay(change?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  try {
    change?.(f);
    const result = f.execute(); assert.equal(result.status, 0, result.stderr);
    return { summary: JSON.parse(readFileSync(join(f.output, "summary.json"), "utf8")), rendered: readFileSync(join(f.output, "operation.md"), "utf8") };
  } finally { f.cleanup(); }
}

test("replay restores actual saved appendix with copied cwd, system and persisted request-only accounting", () => {
  const f = fixture();
  try {
    assert.match(f.inventory, /<read-files>\nsrc\/a.ts\n/);
    const bound = { version: 2, tokens: 50, source: "provider-usage", usageEntryId: "business", evidence: "capture", model: "fake/main", measuredMessages: [] };
    f.run.contextSizes.before.recoveryBound = bound;
    const expected = restoredContext(f.branch, f.committed, 100000, { systemMessage: f.committed.systemMessage, additionalTokens: 73, reserveTokens: 1111, bound: bound as any, recoveryAppendix: f.appendix, handoff: f.body, quotations: f.quotations, inventory: f.inventory });
    const result = f.execute(); assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(f.output, "summary.json"), "utf8"));
    assert.equal(summary.realRequests, 0); assert.equal(summary.originalCutWindowPassed, 1); assert.equal(summary.originalCutWindowUnverified, 0);
    const gate = summary.rows[0].originalCutWindow;
    assert.equal(gate.completeRecoveryVerified, true); assert.equal(gate.window, 100000);
    assert.equal(gate.total, expected.estimated.total); assert.equal(gate.recoveryPackage, expected.estimated.recoveryPackage);
    assert.ok(gate.systemAndTools > 0); assert.ok(gate.inventory > 0); assert.ok(gate.recoveryPackage > 0);
    assert.equal(gate.otherInjected, 73); assert.equal(gate.outputReserve, 1111); assert.deepEqual(gate.providerUpperBound, bound);
    assert.equal(readFileSync(join(f.output, "operation.md"), "utf8"), f.body);
  } finally { f.cleanup(); }
});

for (const [label, change, diagnostic] of [
  ["missing session", (f: any) => { f.run.sessionId = "missing"; }, /Copied session missing is missing/],
  ["missing frozen leaf", (f: any) => { f.run.inputFingerprint.branchLeaf = "missing"; }, /Frozen ancestry entry missing is absent/],
  ["broken ancestry", (f: any) => { f.branch[0].parentId = "missing-parent"; }, /Frozen ancestry entry missing-parent is absent/],
  ["missing cwd", (f: any) => { delete f.header.cwd; }, /header cwd is missing/],
  ["invalid window", (f: any) => { f.run.threshold.effectiveWindow = 0; }, /Invalid recovery window: effective=0/],
  ["null window", (f: any) => { f.run.threshold.effectiveWindow = null; }, /Invalid recovery window: effective=null/],
  ["window exceeds model", (f: any) => { f.run.threshold.effectiveWindow = 200001; }, /Invalid recovery window: effective=200001/],
  ["missing recovery bodies", (f: any) => { f.entries.pop(); }, /Matching persisted custom compaction is missing/],
  ["skill references without owner content", (f: any) => { f.committed.summary = f.committed.summary.split("\n\n### pi-skills")[0]; }, /recovery content is missing for pi-skills/],
  ["missing system", (f: any) => { delete f.committed.systemMessage; }, /systemMessage is missing/],
  ["missing request-only accounting", (f: any) => { delete f.run.contextSizes.after.estimated.otherInjected; }, /requestOnlyTokens accounting/],
  ["invalid bound", (f: any) => { f.run.contextSizes.before.recoveryBound = { version: 1 }; }, /recovery bound is invalid/],
] as Array<[string, (f: ReturnType<typeof fixture>) => void, RegExp]>) test(`replay diagnoses ${label} without counting full recovery as passed`, () => {
  const { summary, rendered } = replay(change), row = summary.rows[0];
  assert.equal(rendered, "普通 Markdown 交接");
  assert.equal(summary.savedResponseAccepted, 1); assert.equal(summary.originalCutWindowPassed, 0); assert.equal(summary.originalCutWindowFailed, 0); assert.equal(summary.originalCutWindowUnverified, 1);
  assert.match(row.historyError ?? row.recoveryError, diagnostic); assert.equal(row.originalCutWindow, undefined);
});

test("owner titles without nonempty section bodies cannot prove complete recovery", () => {
  for (const [owner, body] of [["pi-session-compact", "ACTUAL_COMPACT_BODY"], ["pi-skills", "ACTUAL_SKILL_BODY"]]) {
    const { summary } = replay(f => { f.committed.summary = f.committed.summary.replace(body, " \n\t"); });
    assert.equal(summary.originalCutWindowPassed, 0); assert.equal(summary.originalCutWindowUnverified, 1);
    assert.equal(summary.rows[0].originalCutWindow, undefined);
    assert.ok(summary.rows[0].recoveryError.includes(`recovery content is empty for ${owner}`));
  }
});

test("compact and required skill recovery require canonical customTypes even with matching titles and bodies", () => {
  for (const [owner, customType] of [["pi-session-compact", "pi-session-compact:recovery-v1"], ["pi-skills", "pi-skills:compact-restored-v1"]]) {
    const { summary } = replay(f => {
      f.committed.details.recovery.items.find((item: any) => item.owner === owner).customType = "wrong-type";
      f.committed.summary = f.committed.summary.replace(`(${customType})`, "(wrong-type)");
    });
    assert.equal(summary.originalCutWindowPassed, 0); assert.equal(summary.originalCutWindowUnverified, 1);
    assert.equal(summary.rows[0].originalCutWindow, undefined);
    assert.match(summary.rows[0].recoveryError, /recovery customType is missing or invalid/);
  }
});

test("a verified complete restoration that exceeds the window is failed, not unverified", () => {
  const { summary } = replay(f => { f.run.threshold.effectiveWindow = 1000; });
  assert.equal(summary.originalCutWindowPassed, 0); assert.equal(summary.originalCutWindowFailed, 1); assert.equal(summary.originalCutWindowUnverified, 0);
});

test("saved responses need a matching completed attempt, never a length-truncated or unproven body", () => {
  for (const truncate of [false, true]) {
    const f = fixture();
    try {
      if (truncate) f.run.outputs.main.attempts[0].stopReason = "length";
      else f.run.outputs.main.attempts = [];
      const result = f.execute(); assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(readFileSync(join(f.output, "summary.json"), "utf8"));
      assert.equal(summary.savedResponseAccepted, 0); assert.equal(summary.originalCutWindowPassed, 0);
      assert.deepEqual(readdirSync(f.output), ["summary.json"]);
      if (!truncate) assert.match(summary.rows[0].responseError, /no matching persisted attempt/);
    } finally { f.cleanup(); }
  }
});

test("replay rejects writes into its input copies and symlinked session inputs", () => {
  const f = fixture();
  try {
    const writeIntoInput = f.execute(join(f.input, "output"));
    assert.notEqual(writeIntoInput.status, 0); assert.match(writeIntoInput.stderr, /outside the read-only copied input/);
    const sessionPath = join(f.input, "sessions/copy.jsonl"), elsewhere = join(f.root, "other-copy.jsonl");
    writeFileSync(elsewhere, readFileSync(sessionPath)); rmSync(sessionPath); symlinkSync(elsewhere, sessionPath);
    const result = spawnSync(process.execPath, ["--import", resolver, "--experimental-strip-types", script, f.input, f.output], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(f.root, "isolated-agent") } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Expected copied regular file/);
  } finally { f.cleanup(); }
});
