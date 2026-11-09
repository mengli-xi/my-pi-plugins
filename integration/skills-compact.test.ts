import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { SessionManager, type CompactionEntry, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import skills from "../local/pi-skills/index.ts";
import compact from "../local/pi-session-compact/index.ts";
import { LEGACY_SKILL_BINDING_ENTRY_TYPE, SKILL_BINDING_ENTRY_TYPE, SKILL_INJECTION_MESSAGE_TYPE } from "../local/pi-skills/invocations.ts";
import { COMPACT_SKILLS_MESSAGE, COMPACT_SKILLS_REQUEST } from "../local/pi-skills/compact-recovery.ts";
import { CONTENTS, RULE, skillsFixture, text } from "./fixtures/skills.ts";

const checkpointDetails = (entry: CompactionEntry) => entry.details as {
  operationId: string;
  restoreSkills: Array<{ sourceEntryId: string; name: string; path: string; contentHash: string }>;
  recovery: { version: number; items: Array<{ owner: string; customType: string; covers?: string[]; identity: { skills?: Array<{ sourceEntryId: string }> } }> };
};

// These sessions load the real entry points, public Pi SDK and faux transport.
// No fixture supplies skill materials, recovery text, or a compaction result.
test("Skills supplies real Compact requests and embeds exact rules across two compactions", async () => {
  const f = skillsFixture();
  const runtime = await f.start([skills, compact]);
  const sm = runtime.session.sessionManager;
  try {
    await runtime.session.prompt("Completed background work. ".repeat(150));
    await runtime.session.prompt("Use $deploy for the remaining work.");
    const binding = sm.getBranch().find(entry => entry.type === "custom" && entry.customType === SKILL_BINDING_ENTRY_TYPE);
    assert.ok(binding, "real Skills input/context handlers persist the binding");
    sm.appendCustomEntry("other-owner:state-v1", { private: "Not owned by Skills" });
    for (let round = 0; round < 2; round++) {
      await runtime.session.prompt(`Checkpoint ${round}: completed background work. `.repeat(150));
      const before = f.requests.filter(request => request.model === "small").length;
      await runtime.session.compact();
      const generated = f.requests.filter(request => request.model === "small").slice(before);
      assert.equal(generated.length, 1, "the real Compact small generator calls the faux transport");
      const body = generated[0].messages.map(text).join("\n");
      assert.ok(body.includes(`Loaded skill deploy; path=${f.skillPath}\n${CONTENTS}`), "owner materials reach the actual compaction request, not just the event bus");
      const entry = sm.getBranch().findLast(entry => entry.type === "compaction");
      assert.ok(entry && entry.type === "compaction");
      const details = checkpointDetails(entry);
      assert.equal(details.restoreSkills.length, 1);
      assert.equal(details.restoreSkills[0].sourceEntryId, binding.id);
      assert.equal(details.restoreSkills[0].path, f.skillPath);
      assert.equal(details.recovery.version, 1);
      assert.equal(details.recovery.items.filter(item => item.owner === "pi-skills" && item.customType === COMPACT_SKILLS_MESSAGE).length, 1);
      assert.equal(entry.summary.split(RULE).length - 1, 1, "rules are embedded once even though the generated handoff omits them");
      assert.ok(entry.summary.includes("历史记录 other-owner:state-v1 未恢复"), "Skills does not claim another owner's state");
      assert.equal(entry.summary.includes(`历史记录 ${SKILL_BINDING_ENTRY_TYPE} 未恢复`), false, "the owner declares its binding coverage");
      await runtime.session.prompt("Continue without publishing.");
      assert.ok(f.requests.at(-1)!.messages.some(message => text(message).includes(RULE)), "post-compaction provider request retains the embedded rules");
      assert.equal(sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === COMPACT_SKILLS_MESSAGE).length, 0, "embedded recovery never queues a duplicate standalone message");
    }
    assert.equal(sm.getBranch().filter(entry => entry.type === "compaction").length, 2);
    assert.deepEqual(f.errors, []);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test("legacy skill bindings and foreign material contributors remain separate in real Compact", async () => {
  const f = skillsFixture();
  // This is an arbitrary external protocol participant, not a stand-in for Skills.
  const foreign: ExtensionFactory = pi => {
    pi.events.on("pi-session-compact:collect-materials-v1", (raw: unknown) => {
      const request = raw as { reply: (value: unknown) => void };
      request.reply({ owner: "other-owner", skills: [{ sourceEntryId: foreignId, name: "foreign", path: "/foreign/SKILL.md", contents: "FOREIGN_RULE" }] });
    });
  };
  const sm = SessionManager.create(f.root, `${f.root}/sessions`);
  const legacyId = sm.appendCustomEntry(LEGACY_SKILL_BINDING_ENTRY_TYPE, {
    version: 1, key: "legacy", text: "historical mention", skills: [{ name: "deploy", path: f.skillPath, contents: CONTENTS }],
  });
  const foreignId = sm.appendCustomEntry("other-owner:rules-v1", { private: "not Skills data" });
  const runtime = await f.start([skills, compact, foreign], sm);
  try {
    await runtime.session.prompt("Historical work. ".repeat(150));
    await runtime.session.prompt("Prepare checkpoint. ".repeat(150));
    await runtime.session.compact();
    const generated = f.requests.find(request => request.model === "small");
    assert.ok(generated);
    const body = generated.messages.map(text).join("\n");
    assert.ok(body.includes(`Loaded skill deploy; path=${f.skillPath}\n${CONTENTS}`));
    assert.ok(body.includes("Loaded skill foreign; path=/foreign/SKILL.md\nFOREIGN_RULE"));
    const entry = sm.getBranch().findLast(entry => entry.type === "compaction");
    assert.ok(entry && entry.type === "compaction");
    const details = checkpointDetails(entry);
    assert.deepEqual(new Set(details.restoreSkills.map(ref => ref.sourceEntryId)), new Set([legacyId, foreignId]));
    assert.deepEqual(details.recovery.items.find(item => item.owner === "pi-skills")?.identity.skills?.map(ref => ref.sourceEntryId), [legacyId], "Skills proves only its own legacy binding, never a foreign reference");
    assert.equal(entry.summary.split(RULE).length - 1, 1);
    assert.equal(entry.summary.includes("FOREIGN_RULE"), false);
    assert.ok(entry.summary.includes("历史记录 other-owner:rules-v1 未恢复"));
    assert.equal(entry.summary.includes(`历史记录 ${LEGACY_SKILL_BINDING_ENTRY_TYPE} 未恢复`), false);
    await runtime.session.prompt("Continue normally.");
    assert.equal(runtime.session.getLastAssistantText(), "LOCAL_FAUX_OK", "a foreign material reference cannot cancel the request");
    assert.deepEqual(f.errors, []);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test("a foreign material replacing the same path never revives older Skills rules", async () => {
  const f = skillsFixture();
  let foreignId = "";
  const foreign: ExtensionFactory = pi => {
    pi.events.on("pi-session-compact:collect-materials-v1", (raw: unknown) => {
      const request = raw as { reply: (value: unknown) => void };
      request.reply({ owner: "other-owner", skills: [{ sourceEntryId: foreignId,
        name: "deploy", path: f.skillPath, contents: "FOREIGN_CURRENT_RULE" }] });
    });
  };
  const runtime = await f.start([skills, compact, foreign]);
  try {
    await runtime.session.prompt("Use $deploy for the remaining work.");
    foreignId = runtime.session.sessionManager.appendCustomEntry("other-owner:rules-v1", {});
    await runtime.session.prompt("Completed background work. ".repeat(150));
    await runtime.session.prompt("Prepare a checkpoint. ".repeat(150));
    await runtime.session.compact();
    const generated = f.requests.find(request => request.model === "small");
    assert.ok(generated?.messages.map(text).join("\n").includes("FOREIGN_CURRENT_RULE"));
    const entry = runtime.session.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
    assert.ok(entry && entry.type === "compaction");
    assert.deepEqual(checkpointDetails(entry).restoreSkills.map(ref => ref.sourceEntryId), [foreignId]);
    assert.equal(checkpointDetails(entry).recovery.items.some(item => item.owner === "pi-skills"), false);
    assert.equal(entry.summary.includes(RULE), false, "nonempty foreign refs cannot fall back to old Skills rules");
    await runtime.session.prompt("Continue normally.");
    assert.equal(runtime.session.getLastAssistantText(), "LOCAL_FAUX_OK");
    assert.deepEqual(f.errors, []);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test("legacy public restore requests persist exact rules before a real request and remain idempotent", async () => {
  const f = skillsFixture();
  const sm = SessionManager.create(f.root, `${f.root}/sessions`);
  const sourceEntryId = sm.appendCustomEntry(LEGACY_SKILL_BINDING_ENTRY_TYPE, {
    version: 1, key: "legacy", text: "historical mention", skills: [{ name: "deploy", path: f.skillPath, contents: CONTENTS }],
  });
  const firstKept = sm.appendMessage({ role: "user", content: "Previous task", timestamp: 1 });
  sm.appendMessage(fauxAssistantMessage("Previous answer"));
  const refs = [{ sourceEntryId, name: "deploy", path: f.skillPath, contentHash: createHash("sha256").update(CONTENTS).digest("hex") }];
  sm.appendCompaction("LEGACY_HANDOFF", firstKept, 1000, { version: 2, operationId: "legacy-operation", restoreSkills: refs });
  // Drive the old public endpoint; the actual Skills extension owns delivery and proof.
  const requestLegacy: ExtensionFactory = pi => {
    pi.on("before_agent_start", (_event, ctx) => {
      pi.events.emit(COMPACT_SKILLS_REQUEST, { version: 1, sessionId: ctx.sessionManager.getSessionId(),
        operationId: "legacy-operation", skills: refs, beforeAgentStart: true });
    });
  };
  const runtime = await f.start([skills, compact, requestLegacy], sm);
  try {
    for (let round = 0; round < 2; round++) {
      await runtime.session.prompt(`Continue legacy operation ${round}.`);
      assert.equal(f.requests.length, round + 1);
      assert.equal(f.requests.at(-1)!.messages.map(text).join("\n").split(RULE).length - 1, 1);
      const recovery = sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === COMPACT_SKILLS_MESSAGE);
      assert.equal(recovery.length, 1, "repeated legacy requests never duplicate the standalone message");
      assert.ok(JSON.stringify(recovery[0]).includes(RULE), "rules are durable before the provider is allowed to run");
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test("Skills without Compact keeps user text exact and restores only request-side instructions on resume", async () => {
  const f = skillsFixture();
  let runtime = await f.start([skills]);
  try {
    const prompt = "Use $deploy now.";
    await runtime.session.prompt(prompt);
    const first = f.requests.at(-1)!.messages;
    const index = first.findIndex(message => message.role === "user" && text(message) === prompt);
    assert.ok(index >= 0);
    assert.equal(first[index + 1]?.role, "user");
    assert.ok(text(first[index + 1]).includes(`<path>${f.skillPath}</path>`));
    assert.ok(text(first[index + 1]).includes(RULE));
    const sm = runtime.session.sessionManager;
    const persisted = sm.getEntries();
    assert.ok(persisted.some(entry => entry.type === "message" && entry.message.role === "user" && text(entry.message) === prompt), "the session preserves the exact user mention");
    assert.equal(persisted.filter(entry => entry.type === "custom" && entry.customType === SKILL_BINDING_ENTRY_TYPE).length, 1);
    assert.equal(persisted.some(entry => entry.type === "custom_message" && entry.customType === SKILL_INJECTION_MESSAGE_TYPE), false);
    assert.equal(persisted.some(entry => entry.type === "message" && JSON.stringify(entry.message).includes(RULE)), false, "rules live in the non-context sidecar, not durable user/LLM messages");
    const file = sm.getSessionFile();
    assert.ok(file);
    await runtime.dispose();
    writeFileSync(f.skillPath, CONTENTS.replace(RULE, "CHANGED_DISK_RULE_MUST_NOT_REPLACE_SNAPSHOT"));
    runtime = await f.start([skills], SessionManager.open(file));
    await runtime.session.prompt("Continue after resume.");
    const resumed = f.requests.at(-1)!.messages.map(text).join("\n");
    assert.equal(resumed.split(RULE).length - 1, 1, "the persisted version returns exactly once");
    assert.equal(resumed.includes("CHANGED_DISK_RULE_MUST_NOT_REPLACE_SNAPSHOT"), false);
    assert.equal(runtime.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === SKILL_BINDING_ENTRY_TYPE).length, 1, "resume does not proliferate sidecars");
    assert.deepEqual(f.errors, []);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test("Compact without Skills still compacts and completes the next ordinary request", async () => {
  const f = skillsFixture();
  const runtime = await f.start([compact]);
  try {
    await runtime.session.prompt("Use $deploy. Completed background work. ".repeat(150));
    await runtime.session.prompt("Continue background work. ".repeat(150));
    await runtime.session.compact();
    await runtime.session.prompt("Continue after compaction.");
    assert.equal(runtime.session.getLastAssistantText(), "LOCAL_FAUX_OK");
    assert.equal(f.requests.filter(request => request.model === "small").length, 1);
    const entry = runtime.session.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
    assert.ok(entry && entry.type === "compaction");
    assert.equal(checkpointDetails(entry).recovery.items.some(item => item.owner === "pi-skills"), false);
    assert.equal(entry.summary.includes(RULE), false);
    assert.deepEqual(f.errors, []);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});
