import assert from "node:assert/strict";
import test from "node:test";
import { builtinRoles } from "../../src/roles/builtins.ts";
import { assembleChildPromptV1, childPromptFingerprint } from "../../src/capabilities/prompt.ts";
import { canonicalJson } from "../../src/capabilities/canonical.ts";
import { capabilityFingerprint, toolDefinitionDigest } from "../../src/capabilities/fingerprint.ts";

const role = builtinRoles("2026-01-01T00:00:00.000Z").get("default")!;
const skill = "a".repeat(64);

test("default assembler emits exact sorted tools, guidelines, context, role and protocol", () => {
  const result = assembleChildPromptV1({
    cwd: "C:\\work\\repo",
    role,
    skillSha256: skill,
    appendSystemPrompt: "append\r\ntext",
    contextFiles: [{ path: 'a&"b', content: "rule\r\nbody" }],
    tools: [
      { name: "write", promptSnippet: "Write a file", promptGuidelines: ["Preserve unrelated edits"] },
      { name: "read", promptSnippet: "Read a file", promptGuidelines: ["Preserve unrelated edits", "Inspect first"] },
      { name: "hidden", promptGuidelines: [] },
    ],
  });
  assert.equal(result.content.startsWith(
    "You are an expert coding assistant running as a persistent background Subagent inside pi. Complete the admitted task within the capabilities listed below.\n\nAvailable tools:\n- read: Read a file\n- write: Write a file\n\nGuidelines:\n- Preserve unrelated edits\n- Inspect first\n- Be concise in your responses\n- Show file paths clearly when working with files",
  ), true);
  assert.match(result.content, /<project_instructions path="a&amp;&quot;b">\nrule\nbody/);
  assert.match(result.content, /Current working directory: C:\/work\/repo/);
  assert.match(result.content, /--- pi-subagents role ---/);
  assert.match(result.content, /--- pi-subagents protocol ---/);
  assert.equal(result.content.endsWith("\n"), true);
  assert.equal(result.bytes, Buffer.byteLength(result.content));
  assert.match(result.sha256, /^[0-9a-f]{64}$/u);
});

test("custom prompt replaces baseline and fingerprints include skill digest", () => {
  const result = assembleChildPromptV1({
    customPrompt: "custom\r\nbase",
    cwd: "/repo",
    role,
    skillSha256: skill,
    tools: [{ name: "read", promptSnippet: "Read", promptGuidelines: [] }],
  });
  assert.equal(result.content.startsWith("custom\nbase\nCurrent working directory: /repo"), true);
  assert.equal(result.content.includes("Available tools:"), false);
  assert.notEqual(childPromptFingerprint(result, skill), childPromptFingerprint(result, "b".repeat(64)));
});

test("canonical JSON and definition fingerprints are insertion-order stable and fail closed", () => {
  assert.equal(canonicalJson({ b: 2, a: [true, null] }), '{"a":[true,null],"b":2}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ value: 1.5 }), /safe integers/);
  assert.throws(() => canonicalJson(new Date()), /plain JSON/);
  const input = {
    name: "read",
    owner_id: "builtin",
    description: "Read",
    parameters: { type: "object" },
    prompt_guidelines: ["Inspect"],
  } as const;
  assert.equal(toolDefinitionDigest(input), toolDefinitionDigest({ ...input, parameters: { type: "object" } }));
  assert.notEqual(capabilityFingerprint({ version: 1 }), capabilityFingerprint({ version: 2 }));
});

test("assembler always tells the child which tools it has and whether it can still spawn", () => {
  const base = { cwd: "/repo", role, skillSha256: skill, customPrompt: "custom", tools: [{ name: "read", promptGuidelines: [] }, { name: "grep", promptGuidelines: [] }] };
  const leaf = assembleChildPromptV1({ ...base, depth: 2 });
  assert.match(leaf.content, /--- pi-subagents capabilities ---\nTools available to this Subagent: grep, read\./);
  assert.match(leaf.content, /depth 2 of the Agent tree\. spawn_agent is unavailable at this depth\./);
  const child = assembleChildPromptV1({ ...base, depth: 1 });
  assert.match(child.content, /depth 1 of the Agent tree\. Children you spawn are at depth 2 and cannot spawn further\./);
  const unknown = assembleChildPromptV1({ ...base, tools: [] });
  assert.match(unknown.content, /Tools available to this Subagent: \(none\)\./);
  assert.doesNotMatch(unknown.content, /of the Agent tree/);
  assert.match(unknown.content, /must be the only tool call in its assistant message/);
});
