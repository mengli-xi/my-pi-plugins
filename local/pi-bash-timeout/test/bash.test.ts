import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBashToolDefinition, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createBashTimeoutChildFactory, createBashTimeoutTool } from "../extensions/tool.ts";

function context(cwd: string): ExtensionToolContext {
  return { cwd, sessionManager: { getSessionId: () => "bash-test", getSessionFile: () => undefined } } as ExtensionToolContext;
}

test("timeout is required and positive; all other definition fields match Pi", () => {
  const builtin = createBashToolDefinition(process.cwd());
  const tool = createBashTimeoutTool(() => ({}));
  assert.equal(tool.defaultActive, false);
  assert.deepEqual(tool.parameters.required, ["command", "timeout"]);
  assert.deepEqual(tool.parameters.properties.command, builtin.parameters.properties.command);
  for (const timeout of [undefined, 0, -1, "1", Infinity, NaN]) {
    assert.equal(Value.Check(tool.parameters, { command: "true", timeout }), false);
  }
  assert.equal(Value.Check(tool.parameters, { command: "true", timeout: 0.125 }), true);
  assert.equal(tool.description.replace("Provide a required", "Optionally provide a"), builtin.description);
  assert.equal(tool.promptSnippet, builtin.promptSnippet);
  assert.deepEqual(tool.promptGuidelines, builtin.promptGuidelines);
  assert.deepEqual(tool.outputSchema, builtin.outputSchema);
  assert.deepEqual(tool.constrainedSampling, builtin.constrainedSampling);
  assert.equal("renderCall" in tool, false);
  assert.equal("renderResult" in tool, false);
});

test("Pi 1.5 pi-schema keeps the timeout required and positive after stock coercion", () => {
  const tool = createBashTimeoutTool(() => ({}));
  assert.equal("prepareArguments" in tool, false);
  const validate = (timeout: unknown) => validateToolArguments(tool, {
    id: "schema", type: "toolCall", name: "bash", arguments: { command: "true", timeout },
  } as never);
  for (const timeout of [undefined, null, 0, -1, "0", "-1", Infinity, NaN, {}, []]) {
    assert.throws(() => validate(timeout), /Validation failed for tool "bash"/);
  }
  for (const timeout of [0.125, "0.125"]) {
    assert.deepEqual(validate(timeout), { command: "true", timeout: 0.125 });
  }
});

test("Pi receives the exact timeout, signal, prefix, cwd, spawn hook and session env", async () => {
  const cwd = process.cwd();
  const signal = new AbortController().signal;
  let observed: unknown;
  const tool = createBashTimeoutTool(() => ({
    commandPrefix: "PREFIX",
    spawnHook: input => ({ ...input, command: `${input.command}\nHOOK` }),
    operations: { async exec(command, actualCwd, options) {
      observed = { command, cwd: actualCwd, timeout: options.timeout, signal: options.signal, session: options.env?.PI_SESSION_ID };
      options.onData(Buffer.from("delegated"));
      return { exitCode: 0 };
    } },
  }));
  const updates: unknown[] = [];
  const result = await tool.execute("id", { command: "COMMAND", timeout: 0.125 }, signal, update => updates.push(update), context(cwd));
  assert.deepEqual(observed, { command: "PREFIX\nCOMMAND\nHOOK", cwd, timeout: 0.125, signal, session: "bash-test" });
  assert.deepEqual(result.content, [{ type: "text", text: "delegated" }]);
  assert.ok(updates.length > 0);
});

test("short command and timeout produce the same output/error as built-in bash", async () => {
  const ctx = context(process.cwd());
  const builtin = createBashToolDefinition(ctx.cwd);
  const tool = createBashTimeoutTool(() => ({}));
  const args = { command: "printf SHORT_OK", timeout: 2 };
  assert.deepEqual((await tool.execute("short", args, undefined, undefined, ctx)).content,
    (await builtin.execute("short", args, undefined, undefined, ctx)).content);
  const errorText = async (execute: typeof builtin.execute) => {
    try { await execute("timeout", { command: "sleep 5", timeout: 1 }, undefined, undefined, ctx); }
    catch (error) { assert.ok(error instanceof Error); return error.message; }
    assert.fail("sleep must time out");
  };
  assert.equal(await errorText(tool.execute), await errorText(builtin.execute));
  assert.equal(await errorText(tool.execute), "Command timed out after 1 seconds");
});

test("factory uses Pi's effective settings, including shellPath, with no config files", async t => {
  const root = await mkdtemp(join(tmpdir(), "bash-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = join(root, "shell");
  await writeFile(shell, "#!/bin/sh\nprintf CUSTOM_SHELL: >&2\nexec /bin/bash \"$@\"\n", { mode: 0o700 });
  let tool: ReturnType<typeof createBashTimeoutTool> | undefined;
  createBashTimeoutChildFactory()({
    getSettings: () => ({ shellPath: shell, shellCommandPrefix: "export BASH_PREFIX=PREFIX_OK" }),
    registerTool: value => { tool = value as unknown as typeof tool; },
  } as ExtensionAPI);
  // 本用例断言 settings 传递，不把宿主 login shell 的启动耗时当性能门禁。
  const result = await tool!.execute("settings", { command: "printf \"$BASH_PREFIX\"", timeout: 15 }, undefined, undefined, context(root));
  assert.equal(result.content.map(part => part.type === "text" ? part.text : "").join(""), "CUSTOM_SHELL:PREFIX_OK");
});

test("faux missing timeout is rejected by the real Pi loop and returned to the model without execution", async t => {
  const root = await mkdtemp(join(tmpdir(), "bash-faux-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "must-not-exist");
  const faux = createFauxCore({});
  let calls = 0;
  const definition = createBashTimeoutTool(() => ({}));
  const tool = { ...definition, async execute(id: string, args: { command: string; timeout?: number }, signal?: AbortSignal) {
    calls++;
    return definition.execute(id, args, signal, undefined, context(root));
  } };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: `printf EXECUTED > '${marker}'` }), { stopReason: "toolUse" }),
    modelContext => {
      const result = modelContext.messages.find(message => message.role === "toolResult");
      assert.ok(result && result.role === "toolResult" && result.isError);
      assert.match(JSON.stringify(result.content), /timeout/);
      return fauxAssistantMessage("VALIDATION_ERROR_SEEN");
    },
  ]);
  await runAgentLoop(
    [{ role: "user", content: [{ type: "text", text: "missing timeout" }], timestamp: Date.now() }] as never,
    { systemPrompt: "", messages: [], tools: [tool] } as never,
    { model: faux.getModel(), tools: [tool], convertToLlm: (messages: unknown[]) => messages, apiKey: "fixture" } as never,
    () => {}, undefined, faux.streamSimple as never,
  );
  assert.equal(calls, 0);
  assert.equal(faux.state.callCount, 2);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
