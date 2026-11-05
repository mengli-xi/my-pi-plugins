import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assembleFragments, buildReport, listRules, loadModelPrompt } from "../report.ts";

test("returns trimmed content for an existing model file", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompts-"));
  writeFileSync(join(dir, "gpt-5.6-sol.md"), "\n## Model calibration\nact fast\n\n");
  assert.equal(loadModelPrompt(dir, "gpt-5.6-sol"), "## Model calibration\nact fast");
});

test("returns undefined when no file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompts-"));
  assert.equal(loadModelPrompt(dir, "grok-4.6"), undefined);
});

test("returns undefined for an empty or whitespace-only file", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompts-"));
  writeFileSync(join(dir, "glm-5.md"), "  \n\n");
  assert.equal(loadModelPrompt(dir, "glm-5"), undefined);
});

test("maps path separators in model ids to underscores", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompts-"));
  writeFileSync(join(dir, "openai_gpt-5.5.md"), "block");
  assert.equal(loadModelPrompt(dir, "openai/gpt-5.5"), "block");
  assert.equal(loadModelPrompt(dir, "../gpt-5.5"), undefined);
});

test("listRules reports every md file with sizes and symlink targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompts-"));
  writeFileSync(join(dir, "gpt-5.6-sol.md"), "calibration");
  symlinkSync("gpt-5.6-sol.md", join(dir, "gpt-5.6-sol-max.md"));
  writeFileSync(join(dir, "notes.txt"), "ignored");
  const rules = listRules(dir);
  assert.deepEqual(
    rules.map((rule) => ({ ...rule })),
    [
      { file: "gpt-5.6-sol-max.md", modelId: "gpt-5.6-sol-max", chars: 11, linkTarget: "gpt-5.6-sol.md" },
      { file: "gpt-5.6-sol.md", modelId: "gpt-5.6-sol", chars: 11 },
    ],
  );
  assert.deepEqual(listRules(join(dir, "missing")), []);
});

test("buildReport shows status, injected content, and all rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompts-"));
  writeFileSync(join(dir, "gpt-5.6-sol.md"), "calibration");
  const report = buildReport(dir, "gpt-5.6-sol", {
    modelId: "gpt-5.6-sol",
    fragments: [{ key: "model:gpt-5.6-sol", chars: 11 }, { key: "effort:ultra", chars: 40 }],
  });
  assert.match(report, /Model: gpt-5\.6-sol/);
  assert.match(report, /Rule: gpt-5\.6-sol\.md \(11 chars\)/);
  assert.match(report, /Last run: injected 51 chars .*model:gpt-5\.6-sol \(11\), effort:ultra \(40\)/);
  assert.match(report, /Current prompt source\n───────────────\ncalibration/);
  assert.match(report, /not the final provider request/);
});

test("buildReport handles a missing rule, no model, and no run yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompts-"));
  const missing = buildReport(dir, "grok-4.6", undefined);
  assert.match(missing, /missing or empty; nothing is injected/);
  assert.match(missing, /no agent run yet in this session/);
  assert.match(buildReport(dir, undefined, undefined), /No model selected\./);
  const none = buildReport(dir, "grok-4.6", { modelId: "grok-4.6", fragments: [] });
  assert.match(none, /Last run: nothing injected for grok-4\.6/);
});

test("assembleFragments joins in key order regardless of insertion order", () => {
  const m = new Map([["model:z", "ZZZ"], ["effort:ultra", "UUU"]]);
  assert.equal(assembleFragments(m), "UUU\n\nZZZ");
  assert.equal(assembleFragments(new Map()), "");
});


test("session changes clear contribution metadata without hiding current files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-session-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, "model-prompts"));
  writeFileSync(join(dir, "model-prompts/model-a.md"), "before");
  const { default: register } = await import("../index.ts");
  const hooks = new Map<string, Function>();
  let command: any;
  let text = "";
  register({
    on(name: string, fn: Function) { hooks.set(name, fn); },
    events: { emit() {} },
    registerCommand(_name: string, value: unknown) { command = value; },
  } as never);
  const ctx = { model: { id: "model-a" }, mode: "rpc", hasUI: true,
    ui: { notify(value: string) { text = value; } } };
  hooks.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { selectedTools: [] } }, ctx);
  writeFileSync(join(dir, "model-prompts/model-a.md"), "after edit");
  await command.handler("", ctx);
  assert.match(text, /Current prompt source\n───────────────\nafter edit/);
  assert.match(text, /Last run: injected 6 chars/);
  hooks.get("session_start")!({}, ctx);
  await command.handler("", ctx);
  assert.match(text, /no agent run yet in this session/);
});

test("custom runs without a prompt receive model calibration while Pi is starting", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "model-prompts-custom-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  mkdirSync(join(agentDir, "model-prompts"));
  writeFileSync(join(agentDir, "model-prompts", "test-model.md"), "model calibration");
  const { default: register } = await import("../index.ts");
  let beforeStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
  register({
    on(name: string, handler: typeof beforeStart) { if (name === "before_agent_start") beforeStart = handler; },
    events: { emit() {} },
    registerCommand() {},
  } as never);
  assert.ok(beforeStart);
  const result = beforeStart({
    type: "before_agent_start", messageType: "custom",
    message: { customType: "test-wake", content: "wake", display: false },
    systemPrompt: "base", systemPromptOptions: { selectedTools: [] },
  }, { model: { id: "test-model" }, thinkingLevel: "off", isIdle: () => false });
  assert.deepEqual(result, { systemPrompt: "base\n\nmodel calibration" });
});
