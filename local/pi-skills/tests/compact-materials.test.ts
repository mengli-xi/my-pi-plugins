import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  COMPACT_SKILLS_MESSAGE,
  COMPACT_SKILLS_REQUEST,
  COMPACT_SKILLS_RESPONSE,
  installCompactionSkillRecovery,
  resolveCompactionSkills,
} from "../compact-recovery.ts";

const hash = (contents: string) => createHash("sha256").update(contents).digest("hex");
const skill = (contents = "PERSISTED_RULES", path = "/not-on-disk/SKILL.md") => ({ name: "work", path, contents });
const binding = (id: string, value = skill(), customType = "pi-skills:binding-v1"): any => ({
  type: "custom", id, customType, data: { version: 1, skills: [value] },
});
const ref = (entry: any, value = entry.data.skills[0]) => ({ sourceEntryId: entry.id, name: value.name, path: value.path, contentHash: hash(value.contents) });
function harness(branch: any[] = []) {
  const hooks = new Map<string, any>(), listeners = new Map<string, any>();
  const sent: any[] = [], responses: any[] = [], notices: string[] = [];
  let aborted = 0;
  const ctx: any = { sessionManager: { getSessionId: () => "session", getBranch: () => branch }, ui: { notify: (text: string) => notices.push(text) }, abort: () => aborted++ };
  installCompactionSkillRecovery({
    on: (key: string, fn: any) => hooks.set(key, fn),
    events: { on: (key: string, fn: any) => { listeners.set(key, fn); return () => listeners.delete(key); }, emit: (key: string, value: any) => responses.push({ key, value }) },
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  } as any);
  const collect = (key: string, extra: any = {}) => {
    const replies: any[] = [];
    listeners.get(key)?.({ version: 1, sessionId: "session", operationId: "op", branchEntries: branch, restoreSkills: [], ...extra, reply: (value: any) => replies.push(value) });
    return replies;
  };
  return { branch, hooks, listeners, sent, responses, notices, ctx, collect, start: () => hooks.get("session_start")({}, ctx), get aborted() { return aborted; } };
}
const materials = "pi-session-compact:collect-materials-v1";
const recovery = "pi-session-compact:collect-recovery-v1";

test("materials select the branch's last complete persisted path version, including legacy and proven reads", () => {
  const first = binding("first");
  const legacy = binding("legacy", skill("LEGACY_RULES"), "pi-skill-mentions:binding-v1");
  const readSkill = skill("READ_RULES");
  const read: any = { type: "custom", id: "read", customType: "pi-skills:agent-read-v1", data: { version: 1, source: "agent-read", toolCallId: "t1", skill: readSkill } };
  const partial = binding("partial", { ...skill("PARTIAL"), truncated: true } as any);
  const invalidRead: any = { ...read, id: "invalid", data: { version: 1, skill: skill("UNPROVEN") } };
  const foreign: any = { type: "custom", id: "foreign", customType: "foreign:binding-v1", get data() { throw Error("foreign private data"); } };
  const h = harness([first, legacy, read, partial, invalidRead, foreign]);
  h.start();
  const reply = h.collect(materials)[0];
  assert.equal(reply.owner, "pi-skills");
  assert.deepEqual(reply.skills, [{ ...ref(read, readSkill), contents: "READ_RULES" }]);
  assert.equal(resolveCompactionSkills(h.branch, [ref(legacy)])[0].contents, "LEGACY_RULES");
  assert.equal(resolveCompactionSkills(h.branch, [ref(read, readSkill)])[0].contents, "READ_RULES");
  assert.throws(() => resolveCompactionSkills(h.branch, [ref(invalidRead, invalidRead.data.skill)]));
  invalidRead.data = { ...read.data, toolCallId: undefined };
  assert.throws(() => resolveCompactionSkills(h.branch, [ref(invalidRead, readSkill)]));
  invalidRead.data = { ...read.data, source: "unknown" };
  assert.throws(() => resolveCompactionSkills(h.branch, [ref(invalidRead, readSkill)]));
  h.branch.splice(2);
  assert.deepEqual(h.collect(materials)[0].skills, [{ ...ref(legacy), contents: "LEGACY_RULES" }]);
});

test("collection respects lifecycle/session/version gates and removes both responders on shutdown", () => {
  const h = harness([binding("s1")]);
  assert.deepEqual(h.collect(materials), []);
  assert.deepEqual(h.collect(recovery), []);
  h.start();
  for (const event of [materials, recovery]) {
    assert.deepEqual(h.collect(event, { sessionId: "foreign" }), []);
    assert.deepEqual(h.collect(event, { version: 2 }), []);
  }
  h.hooks.get("session_shutdown")({ reason: "reload" });
  assert.equal(h.listeners.has(materials), false);
  assert.equal(h.listeners.has(recovery), false);
  assert.equal(h.listeners.has(COMPACT_SKILLS_REQUEST), false);
});

test("recovery accepts only its own public tags, covers legacy/read tags, and does not inspect foreign data", () => {
  const own = binding("s1");
  const foreign: any = { type: "custom", id: "foreign", customType: "other:binding-v1", get data() { throw Error("not yours"); } };
  const h = harness([own, foreign]); h.start();
  const replies = h.collect(recovery, { restoreSkills: [ref(own), { ...ref(own), sourceEntryId: "foreign" }, { ...ref(own), sourceEntryId: "missing" }] });
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /PERSISTED_RULES/);
  assert.deepEqual(replies[0].identity.skills, [ref(own)]);
  assert.deepEqual(replies[0].covers, ["pi-skills:binding-v1", "pi-skill-mentions:binding-v1", "pi-skills:agent-read-v1"]);
  assert.equal(h.aborted, 0);
  assert.equal(h.sent.length, 0);
});

test("foreign-only references never revive an older Skills version at the same path", () => {
  const own = binding("old", skill("OLD_RULES"));
  const foreign: any = { type: "custom", id: "replacement", customType: "other:rules-v1",
    get data() { throw Error("foreign private data"); } };
  const h = harness([own, foreign]); h.start();
  const replacement = { ...ref(own), sourceEntryId: foreign.id, contentHash: hash("NEW_OWNER_RULES") };
  assert.deepEqual(h.collect(recovery, { restoreSkills: [replacement] }), []);
  assert.deepEqual(h.collect(recovery, { restoreSkills: [{ ...replacement, sourceEntryId: "missing" }] }), []);
  assert.equal(h.aborted, 0);
  assert.equal(h.sent.length, 0);
  assert.match(h.collect(recovery)[0].content, /OLD_RULES/, "only a genuinely empty request allows fallback");
});

test("optional unproven recovery produces no blocking state or disk substitute", () => {
  const own = binding("s1"), h = harness([own]); h.start();
  const replies = h.collect(recovery, { restoreSkills: [{ ...ref(own), contentHash: "forged" }] });
  assert.match(replies[0].error, /Skill version mismatch/);
  assert.equal(replies[0].content, undefined);
  own.data.skills[0].truncated = true;
  assert.deepEqual(h.collect(materials)[0].skills, []);
  assert.match(h.collect(recovery, { restoreSkills: [ref(own)] })[0].error, /Skill version mismatch/);
  h.hooks.get("context")({}, h.ctx);
  assert.equal(h.aborted, 0);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.notices, []);
});

test("two compactions and old standalone references retain exact original rules without duplicates", () => {
  const original = binding("original"), h = harness([original]); h.start();
  const collect = (operationId: string) => {
    const refs = h.collect(materials)[0].skills.map(({ contents, ...reference }: any) => reference);
    const item = h.collect(recovery, { operationId, restoreSkills: [...refs, ...refs] })[0];
    assert.equal(item.content.match(/PERSISTED_RULES/g)?.length, 1);
    assert.deepEqual(item.identity.skills, refs);
    h.branch.push({ type: "compaction", id: operationId, details: { operationId, recovery: { version: 1, items: [item] } } });
    h.listeners.get(COMPACT_SKILLS_REQUEST)({ version: 1, sessionId: "session", operationId, skills: refs });
    h.hooks.get("context")({}, h.ctx);
    return item;
  };
  const first = collect("first");
  h.branch.push({ type: "custom_message", id: "old-restored", customType: COMPACT_SKILLS_MESSAGE, content: "NOT_RULE_PROOF", details: { version: 1, operationId: "old", skills: [ref(original)] } });
  const second = collect("second");
  assert.equal(second.content, first.content);
  assert.doesNotMatch(second.content, /NOT_RULE_PROOF/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.aborted, 0);
  const newer = binding("newer", skill("LATEST_RULES"));
  h.branch.push(newer, { type: "custom_message", id: "later-restored", customType: COMPACT_SKILLS_MESSAGE, details: { skills: [ref(original)] } });
  assert.equal(h.collect(materials)[0].skills[0].contents, "LATEST_RULES");
  assert.equal(resolveCompactionSkills(h.branch, [ref(newer), ref(original), ref(newer)])[0].contents, "LATEST_RULES");
});

test("legacy requests require current-branch operation proof and persist one idempotent standalone message", () => {
  const own = binding("s1"), h = harness([own]); h.start();
  const request = { version: 1, sessionId: "session", operationId: "old", skills: [ref(own)] };
  h.listeners.get(COMPACT_SKILLS_REQUEST)({ ...request, sessionId: "foreign" });
  h.listeners.get(COMPACT_SKILLS_REQUEST)(request);
  assert.equal(h.sent.length, 0);
  h.branch.push({ type: "compaction", id: "c1", details: { operationId: "old" } });
  h.hooks.get("before_agent_start")({}, h.ctx);
  assert.deepEqual(h.sent[0].options, { triggerTurn: false, deliverAs: "nextTurn" });
  h.hooks.get("before_agent_start")({}, h.ctx);
  assert.equal(h.sent.length, 1);
  h.branch.push({ type: "custom_message", id: "persisted", ...h.sent[0].message });
  h.hooks.get("context")({}, h.ctx);
  assert.equal(h.aborted, 0);
  assert.equal(h.responses.at(-1).key, COMPACT_SKILLS_RESPONSE);
  assert.equal(h.responses.at(-1).value.status, "persisted");
  h.listeners.get(COMPACT_SKILLS_REQUEST)(request);
  assert.equal(h.sent.length, 1);
  h.hooks.get("session_tree")({}, h.ctx);
  h.branch.splice(1);
  h.hooks.get("context")({}, h.ctx);
  assert.equal(h.sent.length, 1);
});
