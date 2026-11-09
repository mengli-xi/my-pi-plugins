import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { collectRecovery, includesRecovery, COLLECT_RECOVERY } from "../src/collected-recovery.ts";
const ctx: any = { sessionManager: { getSessionId: () => "s" } };
test("arbitrary owners register ordered recovery; legacy replies default to 100 and late replies are inert", () => {
  const pi: any = { events: createEventBus() }; let late: any;
  pi.events.on(COLLECT_RECOVERY, (r: any) => { late = r.reply; r.reply({ owner: "other-z", customType: "state-z-v1", identity: {}, content: "Z", order: -5 }); });
  pi.events.on(COLLECT_RECOVERY, (r: any) => r.reply({ owner: "legacy", customType: "state-v1", identity: {}, content: "LEGACY" }));
  const result = collectRecovery(pi, ctx, "op", []);
  assert.deepEqual(result.details.items.map(i => i.owner), ["other-z", "pi-session-compact", "legacy"]);
  late({ owner: "late", content: "LATE" }); assert.doesNotMatch(result.appendix, /LATE/);
  assert.ok(includesRecovery({ recovery: { version: 1, items: [{ owner: "legacy", customType: "state-v1", identity: {} }] } }, "legacy", "state-v1"));
});
test("missing owners and old Compact v1 details become notes without inspecting foreign private fields", () => {
  const pi: any = { events: createEventBus() };
  const branch: any[] = [{ type: "custom", customType: "rules:binding-v1", get data() { throw Error("private"); } }, { type: "compaction", details: { version: 1, restoreSkills: [{ name: "old" }], recovery: { version: 1, items: [{ owner: "gone", customType: "gone-state-v1", identity: {} }] } } }];
  const result = collectRecovery(pi, ctx, "op", [], branch);
  assert.match(result.appendix, /rules:binding-v1 未恢复/); assert.match(result.appendix, /gone-state-v1 未恢复/); assert.match(result.appendix, /旧压缩中的技能引用未恢复/);
  pi.events.on(COLLECT_RECOVERY, (r: any) => r.reply({ owner: "new-rules", customType: "rules:state-v1", covers: ["rules:binding-v1", "gone-state-v1"], identity: {}, content: "CURRENT" }));
  const restored = collectRecovery(pi, ctx, "op", [], branch);
  assert.match(restored.appendix, /CURRENT/); assert.doesNotMatch(restored.appendix, /rules:binding-v1 未恢复|gone-state-v1 未恢复/);
});
test("owner failure and invalid replies never cancel optional recovery", () => {
  const pi: any = { events: createEventBus() };
  pi.events.on(COLLECT_RECOVERY, (r: any) => { r.reply({ owner: "missing", error: "unavailable" }); r.reply({ owner: "bad", content: "bad" }); });
  const result = collectRecovery(pi, ctx, "op", []); assert.match(result.appendix, /missing：未恢复/); assert.match(result.appendix, /bad：未恢复/);
});
