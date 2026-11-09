import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  AGENT_SKILL_READ_ENTRY_TYPE,
  AgentSkillReadTracker,
  createLoadedSkillsRenderer,
  CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION,
} from "../loaded-skill-entry.ts";
import { SKILL_BINDING_ENTRY_TYPE } from "../invocations.ts";
import type { SkillRef } from "../skills.ts";

const REGISTRY_KEY = Symbol.for(CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION);
const hints = { keyHint: () => "", keyText: () => "" };

function globals(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

test.afterEach(() => {
  delete globals()[REGISTRY_KEY];
});

test("successful full reads of catalogued skills become ordered durable rows", async () => {
  const path = "/skills/deploy/SKILL.md";
  const contents = "# Deploy\n\nShip safely.";
  const catalog: SkillRef[] = [{ name: "deploy", path, scope: "project" }];
  const tracker = new AgentSkillReadTracker(async () => contents);
  tracker.match({
    toolCallId: "read-1",
    toolName: "read",
    args: { path: `@${path}` },
  }, "/", catalog);
  await tracker.finish({
    toolCallId: "read-1",
    toolName: "read",
    result: { content: [{ type: "text", text: contents }] },
    isError: false,
  });

  assert.deepEqual(tracker.takeForTurn([
    { toolCallId: "other", toolName: "bash" },
    { toolCallId: "read-1", toolName: "read" },
  ]), [{
    version: 1,
    source: "agent-read",
    toolCallId: "read-1",
    skill: {
      name: "deploy",
      path,
      contents: "# Deploy\n\nShip safely.",
    },
  }]);
});

test("file URLs use the same canonical skill identity as Pi read", async () => {
  const path = "/skills/deploy/SKILL.md";
  const contents = "Deploy safely.";
  const tracker = new AgentSkillReadTracker(async () => contents);
  tracker.match({
    toolCallId: "file-url",
    toolName: "read",
    args: { path: pathToFileURL(path).href },
  }, "/", [{ name: "deploy", path, scope: "project" }]);
  await tracker.finish({
    toolCallId: "file-url",
    toolName: "read",
    result: { content: [{ type: "text", text: contents }] },
    isError: false,
  });
  assert.equal(tracker.takeForTurn([
    { toolCallId: "file-url", toolName: "read" },
  ])[0]?.skill.name, "deploy");
});

test("partial, failed, and non-catalogue reads do not claim a loaded skill", async () => {
  const path = "/skills/deploy/SKILL.md";
  const contents = "one\ntwo\nthree";
  const catalog: SkillRef[] = [{ name: "deploy", path, scope: "project" }];
  const tracker = new AgentSkillReadTracker(async () => contents);
  tracker.match({ toolCallId: "partial", toolName: "read", args: { path, limit: 2 } }, "/", catalog);
  await tracker.finish({ toolCallId: "partial", toolName: "read", result: { content: [{ type: "text", text: "one\ntwo\n\n[1 more line in file. Use offset=3 to continue.]" }] }, isError: false });
  tracker.match({ toolCallId: "failed", toolName: "read", args: { path } }, "/", catalog);
  await tracker.finish({ toolCallId: "failed", toolName: "read", result: {}, isError: true });
  tracker.match({ toolCallId: "other", toolName: "read", args: { path: "/tmp/SKILL.md" } }, "/", catalog);
  await tracker.finish({ toolCallId: "other", toolName: "read", result: { content: [{ type: "text", text: "not a skill" }] }, isError: false });
  assert.deepEqual(tracker.takeForTurn([
    { toolCallId: "partial", toolName: "read" },
    { toolCallId: "failed", toolName: "read" },
    { toolCallId: "other", toolName: "read" },
  ]), []);
});

test("contiguous read pages become loaded only after they cover the full skill", async () => {
  const path = "/skills/deploy/SKILL.md";
  const contents = "one\ntwo\nthree\nfour";
  const catalog: SkillRef[] = [{ name: "deploy", path, scope: "project" }];
  const tracker = new AgentSkillReadTracker(async () => contents);

  tracker.match({ toolCallId: "page-1", toolName: "read", args: { path } }, "/", catalog);
  await tracker.finish({
    toolCallId: "page-1",
    toolName: "read",
    result: {
      content: [{ type: "text", text: "one\ntwo\n\n[Showing lines 1-2 of 4. Use offset=3 to continue.]" }],
      details: { truncation: { truncated: true, outputLines: 2 } },
    },
    isError: false,
  });
  assert.deepEqual(tracker.takeForTurn([{ toolCallId: "page-1", toolName: "read" }]), []);

  tracker.match({ toolCallId: "page-2", toolName: "read", args: { path, offset: 3 } }, "/", catalog);
  await tracker.finish({
    toolCallId: "page-2",
    toolName: "read",
    result: { content: [{ type: "text", text: "three\nfour" }] },
    isError: false,
  });
  assert.deepEqual(tracker.takeForTurn([{ toolCallId: "page-2", toolName: "read" }]), [{
    version: 1,
    source: "agent-read",
    toolCallId: "page-2",
    skill: { name: "deploy", path, contents },
  }]);
});

test("loaded skills stay on separate rows and adopt the optional clickable presenter", () => {
  const skills = [
    { name: "deploy", path: "/skills/deploy/SKILL.md", contents: "Deploy safely." },
    { name: "review", path: "/skills/review/SKILL.md", contents: "Review carefully." },
  ];
  const renderer = createLoadedSkillsRenderer(SKILL_BINDING_ENTRY_TYPE);
  const entry = { data: { version: 1, key: "one", text: "$deploy $review", skills } } as never;
  const fallback = renderer(entry, { expanded: false, ...hints }, theme);
  assert.ok(fallback);
  assert.deepEqual(fallback.render(80), [
    "<accent> ✦ Loaded skill deploy</accent>",
    "<accent> ✦ Loaded skill review</accent>",
  ]);

  let clicked: number | undefined;
  globals()[REGISTRY_KEY] = {
    version: 1,
    providers: new Map([[SKILL_BINDING_ENTRY_TYPE, {
      version: 1,
      render: (request: unknown) => {
        const value = request as { skills: typeof skills };
        return {
          render: () => value.skills.map((skill) => `presented ${skill.name}`),
          invalidate() {},
          handleMouse: (event: { y: number }) => { clicked = event.y; return { handled: true }; },
        };
      },
    }]]),
  };
  assert.deepEqual(fallback.render(80), ["presented deploy", "presented review"]);
  assert.equal(fallback.handleMouse?.({ type: "click", button: "left", x: 0, y: 1, width: 80, height: 2, screenX: 0, screenY: 1, shift: false, alt: false, ctrl: false } as never)?.handled, true);
  assert.equal(clicked, 1);
});

test("legacy truncated entries do not expose incomplete contents", () => {
  const renderer = createLoadedSkillsRenderer(SKILL_BINDING_ENTRY_TYPE);
  const component = renderer({
    data: {
      version: 1,
      key: "legacy",
      text: "$deploy",
      skills: [{
        name: "deploy",
        path: "/skills/deploy/SKILL.md",
        contents: "partial",
        truncated: true,
      }],
    },
  } as never, { expanded: false, ...hints }, theme);
  assert.equal(component, undefined);
});

test("agent-read entries use the same standalone renderer", () => {
  const renderer = createLoadedSkillsRenderer(AGENT_SKILL_READ_ENTRY_TYPE);
  const component = renderer({
    data: {
      version: 1,
      source: "agent-read",
      toolCallId: "read-1",
      skill: { name: "deploy", path: "/skills/deploy/SKILL.md", contents: "Deploy safely." },
    },
  } as never, { expanded: true, ...hints }, theme);
  assert.deepEqual(component?.render(80), ["<accent> ✦ Loaded skill deploy</accent>"]);
});

test("nested reads require the matching persisted parent and successful bounded call records", async () => {
  const path = "/skills/deploy/SKILL.md";
  const contents = "Deploy safely.";
  const tracker = new AgentSkillReadTracker(async () => contents);
  const catalog: SkillRef[] = [{ name: "deploy", path, scope: "project" }];
  for (const id of ["loaded", "error", "unfinished", "omitted", "wrong-parent"]) {
    const parentToolCallId = id === "wrong-parent" ? "other-parent" : "codemode-1";
    tracker.match({ toolCallId: id, toolName: "read", parentToolCallId, args: { path } }, "/", catalog);
    await tracker.finish({ toolCallId: id, toolName: "read", parentToolCallId, result: { content: [{ type: "text", text: contents }] }, isError: false });
  }
  const parent = {
    toolCallId: "codemode-1",
    toolName: "codemode",
    nestedCalls: {
      complete: false,
      calls: [
        { id: "loaded", name: "read", status: "ok" as const },
        { id: "error", name: "read", status: "error" as const },
        { id: "unfinished", name: "read", status: "unfinished" as const },
        { id: "wrong-parent", name: "read", status: "ok" as const },
      ],
    },
  };
  assert.deepEqual(tracker.takeForTurn([parent, parent]).map((row) => row.toolCallId), ["loaded"]);
  assert.deepEqual(tracker.takeForTurn([{ toolCallId: "omitted", toolName: "read" }, { ...parent, toolCallId: "other-parent" }]), []);
});
