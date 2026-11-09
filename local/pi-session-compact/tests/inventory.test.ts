import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectInventory as collect, renderInventory } from "../src/inventory.ts";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const user = (id: string): any => ({ type: "message", id, parentId: null, timestamp: "2026-10-19T00:00:00Z", message: { role: "user", content: id, timestamp: 1 } });
const calls = (id: string, values: Array<[string, unknown]>): any => ({ ...user(id), message: { role: "assistant", content: values.map(([name, args], i) => ({ type: "toolCall", id: `${id}-${i}`, name, arguments: args })), timestamp: 1 } });
const compact = (details: unknown, fromHook = true): any => ({ type: "compaction", id: "c", parentId: null, timestamp: "2026-10-19T00:00:00Z", firstKeptEntryId: "retained", summary: "previous", tokensBefore: 1, details, fromHook });
const collectInventory = (branch: SessionEntry[], firstKept: string, cwd = "/workspace") => collect(branch.map((entry, i) => ({ ...entry, parentId: branch[i - 1]?.id ?? null })), firstKept, cwd);

test("unparseable path observations stay verbatim and distinct from valid aliases in calls, nested and legacy", () => {
  const invalid = ["file:///tmp/bad%escape", "@file:///tmp/bad%escape", "file://[invalid]/tmp/note", "file:///tmp/bad%2Fname"];
  const valid = "file:///tmp/bad%25escape";
  const expected = [...invalid, "/tmp/bad%escape"];
  const inputs = [...invalid, valid];
  const direct = collectInventory([calls("ops", inputs.map(path => ["write", { path }])), user("keep")], "keep");
  assert.deepEqual(direct.fileTracking.modifiedFiles, expected);
  assert.deepEqual(direct.fileTracking.order, expected);
  const nested = { ...user("nested"), message: { role: "toolResult", toolName: "script", toolCallId: "script", content: [], nestedCalls: { calls: inputs.map(path => ({ name: "write", arguments: { path } })) } } } as any;
  assert.deepEqual(collectInventory([nested, user("keep")], "keep").fileTracking.modifiedFiles, expected);
  const prior = { generator: "pi-session-compact", fileTracking: { readFiles: [], modifiedFiles: inputs }, legacyFileTracking: { readFiles: inputs, modifiedFiles: [], omitted: 0 } };
  const inherited = collectInventory([user("retained"), compact(prior), user("keep")], "keep");
  assert.deepEqual(inherited.legacyFileTracking?.modifiedFiles, expected);
  assert.equal(inherited.legacyFileTracking?.readFiles.length, 0);
  assert.doesNotMatch(renderInventory(direct), /resolved:|raw:/);
});

test("inventory preserves builtin tilde, at-prefix and file URL semantics across calls, nested calls and legacy", async () => {
  const cwd = "/private/tmp/compact-review-cwd";
  const inputs = ["~/review-note.md", "./~/review-note.md", "file:///private/tmp/review-note.md", "@docs/note.md", "./@docs/note.md", "space\u202fname.md"];
  const expected = [join(homedir(), "review-note.md"), "./~/review-note.md", "/private/tmp/review-note.md", "docs/note.md", "./@docs/note.md", "space name.md"];
  const written: string[] = [];
  const tool = createWriteToolDefinition(cwd, { operations: { mkdir: async () => {}, writeFile: async path => { written.push(path); } } });
  for (const path of inputs) await tool.execute("oracle", { path, content: "" }, undefined, undefined, {} as any);
  const result = collectInventory([calls("ops", inputs.map(path => ["write", { path }])), user("keep")], "keep", cwd);
  assert.deepEqual(result.fileTracking.modifiedFiles, expected);
  assert.equal(result.fileTracking.order.length, inputs.length);
  const originals = [...written]; written.length = 0;
  for (const path of expected) await tool.execute("roundtrip", { path, content: "" }, undefined, undefined, {} as any);
  assert.deepEqual(written, originals, "display paths resolve to the same actual builtin targets");
  const nested = { ...user("nested"), message: { role: "toolResult", toolName: "script", toolCallId: "script", content: [], nestedCalls: { calls: inputs.map(path => ({ name: "write", arguments: { path } })) } } } as any;
  assert.deepEqual(collectInventory([nested, user("keep")], "keep", cwd).fileTracking.modifiedFiles, expected);
  const prior = { generator: "pi-session-compact", fileTracking: { readFiles: [], modifiedFiles: inputs }, legacyFileTracking: { readFiles: inputs, modifiedFiles: [], omitted: 0 } };
  assert.deepEqual(collectInventory([user("retained"), compact(prior), user("keep")], "keep", cwd).legacyFileTracking?.modifiedFiles, expected);
});

test("session cwd unifies absolute/relative paths in calls, nested calls and inherited inventory", () => {
  const cwd = "/workspace/project";
  const result = collectInventory([
    calls("ops", [["read", { path: `${cwd}/docs/design.md` }], ["read", { path: "./docs/../docs/design.md" }], ["write", { path: "docs/design.md" }],
      ["read", { path: "../shared.md" }], ["read", { path: "/workspace/shared.md" }], ["read", { path: "../project-other/outside.md" }]]),
    { ...user("nested"), message: { role: "toolResult", toolName: "script", toolCallId: "script1", content: [], nestedCalls: { calls: [{ name: "read", arguments: { path: `${cwd}/docs/design.md` } }] } } } as any,
    user("keep"), calls("tail", [["write", { path: "tail.ts" }]])
  ], "keep", cwd);
  assert.deepEqual(result.fileTracking, { readFiles: ["/workspace/shared.md", "/workspace/project-other/outside.md"], modifiedFiles: ["docs/design.md"],
    order: ["/workspace/shared.md", "/workspace/project-other/outside.md", "docs/design.md"], omitted: 0 });

  const prior = { generator: "pi-session-compact", fileTracking: { readFiles: [`${cwd}/cached.md`, "cached.md", `${cwd}/deleted.md`], modifiedFiles: [`${cwd}/cached.md`], omitted: 0 },
    legacyFileTracking: { readFiles: ["./cached.md"], modifiedFiles: [], omitted: 0 } };
  const inherited = collectInventory([calls("deleted", [["read", { path: "deleted.md" }]]), user("retained"), compact(prior),
    { ...user("delete"), type: "context_edit", targetId: "deleted", replacement: null } as any, user("keep")], "keep", cwd);
  assert.deepEqual(inherited.fileTracking.readFiles, []);
  assert.deepEqual(inherited.legacyFileTracking, { readFiles: [], modifiedFiles: ["cached.md"], order: ["cached.md"], omitted: 0 });
});

test("files use builtin paths and nested calls, exclude modified from reads and keep the tail out", () => {
  const branch: SessionEntry[] = [user("start"), calls("ops", [["read", { path: "a.ts" }], ["read", { path: "b.ts" }], ["edit", { path: "a.ts" }], ["write", { path: "c.ts" }], ["bash", { command: "cat hidden.ts", path: "hidden.ts" }], ["Read", { path: "other.ts" }], ["read", { file_path: "wrong.ts" }], ["read", { path: "" }]]),
    { ...user("nested"), message: { role: "toolResult", toolName: "script", toolCallId: "script1", content: [], nestedCalls: { calls: [{ name: "read", arguments: { path: "nested.md" } }, { name: "write", arguments: { path: "b.ts" } }] } } } as any,
    user("keep"), calls("tail", [["read", { path: "tail.ts" }]])];
  const result = collectInventory(branch, "keep");
  assert.deepEqual(result.fileTracking, { readFiles: ["nested.md"], modifiedFiles: ["a.ts", "c.ts", "b.ts"], order: ["a.ts", "c.ts", "nested.md", "b.ts"], omitted: 0 });
  assert.equal(renderInventory(result), "\n\n<read-files>\nnested.md\n</read-files>\n\n<modified-files>\na.ts\nc.ts\nb.ts\n</modified-files>");
});

test("custom previous details accumulate with retained old calls and native previous details", () => {
  const retained = calls("retained", [["read", { path: "old-tail.ts" }]]);
  const own = { generator: "pi-session-compact", fileTracking: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"], order: ["b.ts", "a.ts"], omitted: 2 } };
  for (const [details, fromHook] of [[own, true], [{ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] }, false], [{ generator: "pi-native", nativeDetails: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] } }, true]] as const) {
    const branch = [calls("gone", [["read", { path: "do-not-rescan.ts" }]]), retained, compact(details, fromHook), calls("fresh", [["read", { path: "b.ts" }], ["write", { path: "a.ts" }]]), user("keep")];
    const result = collectInventory(branch, "keep");
    assert.deepEqual(result.fileTracking.readFiles, ["do-not-rescan.ts", "old-tail.ts", "b.ts"]);
    assert.deepEqual(result.fileTracking.modifiedFiles, ["a.ts"]);
    assert.equal(result.fileTracking.omitted, 0);
    assert.deepEqual(result.legacyFileTracking?.modifiedFiles, ["b.ts"]);
  }
  const foreign = collectInventory([retained, compact({ readFiles: ["foreign.ts"] }), user("keep")], "keep");
  assert.deepEqual(foreign.fileTracking.readFiles, ["old-tail.ts"]);
});

test("current projection ignores deleted calls and tracks replacement calls", () => {
  const branch: SessionEntry[] = [user("start"), calls("deleted", [["read", { path: "deleted.ts" }]]), calls("changed", [["read", { path: "stale.ts" }]]),
    { ...user("delete"), type: "context_edit", targetId: "deleted", replacement: null } as any,
    { ...user("replace"), type: "context_edit", targetId: "changed", replacement: calls("replacement", [["read", { path: "current.ts" }]]).message } as any,
    user("keep")];
  assert.deepEqual(collectInventory(branch, "keep").fileTracking.readFiles, ["current.ts"]);
});

test("more than 200 available paths are rebuilt and cache-only paths remain explicit legacy", () => {
  const paths = Array.from({ length: 300 }, (_, i) => `old-${i}.ts`);
  const prior = { generator: "pi-session-compact", fileTracking: { readFiles: paths, modifiedFiles: [], order: paths, omitted: 7 } };
  const result = collectInventory([calls("all-originals", paths.map(path => ["read", { path }])), user("retained"), compact(prior), user("keep")], "keep");
  assert.equal(result.fileTracking.order.length, 300); assert.equal(result.fileTracking.omitted, 0);
  const legacy = collectInventory([user("retained"), compact(prior), user("keep")], "keep");
  assert.equal(legacy.fileTracking.order.length, 0); assert.equal(legacy.legacyFileTracking?.order.length, 300);
  assert.match(renderInventory(legacy), /Legacy file inventory.*not reverified/);
});

test("legacy skillPaths are ignored while file inventories remain cumulative", () => {
  const prior = { generator: "pi-session-compact", fileTracking: { readFiles: ["old.ts"], modifiedFiles: [], order: ["old.ts"] }, skillPaths: [{ name: "old", path: "/skills/old/SKILL.md" }, null, "malformed"] };
  const inventory = collectInventory([user("retained"), compact(prior), user("keep")], "keep");
  assert.deepEqual(Object.keys(inventory), ["fileTracking", "legacyFileTracking"]);
  assert.deepEqual(inventory.legacyFileTracking?.readFiles, ["old.ts"]);
  assert.doesNotMatch(renderInventory(inventory), /skill|SKILL.md/);
});

test("context edits revoke cached paths after a previous compaction", () => {
  const original = calls("read", [["read", { path: "/deleted-evidence.txt" }]]);
  const first = collectInventory([original, user("retained")], "retained");
  for (const replacement of [null, calls("new", [["read", { path: "/replacement.txt" }]]).message]) {
    const next = collectInventory([original, user("retained"), compact({ generator: "pi-session-compact", ...first }), { type: "context_edit", id: "edit", timestamp: "t", targetId: "read", replacement } as any, user("keep")], "keep");
    assert.equal(next.fileTracking.readFiles.includes("/deleted-evidence.txt"), false);
    assert.equal(next.legacyFileTracking?.readFiles.includes("/deleted-evidence.txt") ?? false, false);
    assert.deepEqual(next.fileTracking.readFiles, replacement ? ["/replacement.txt"] : []);
  }
});
