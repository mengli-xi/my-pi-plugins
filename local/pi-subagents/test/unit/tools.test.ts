import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collaborationDefinitions, registerCollaborationTools, waitAgentsIsStandaloneV1 } from "../../src/tools/register.ts";
import { localCollaborationQuery } from "../../src/tools/local-query.ts";
import { COLLABORATION_TOOL_NAMES } from "../../src/tools/results.ts";
import {
  validateListAgentsInput,
  validateListSubagentModelsInput,
  validateListSubagentRolesInput,
  validateSpawnAgentInput,
  validateSendInput,
  validateCloseAgentInput,
  validateTargetInput,
  validateTargetMessageInput,
  validateWaitAgentsInput,
} from "../../src/tools/validate.ts";
import { HOST_ERROR_CODES } from "../../src/tools/errors.ts";

test("eight active collaboration definitions are exact and closed", () => {
  const definitions = collaborationDefinitions();
  assert.deepEqual(definitions.map(({ name }) => name), COLLABORATION_TOOL_NAMES);
  assert.equal(new Set(definitions.map(({ name }) => name)).size, 8);
  for (const definition of definitions) {
    assert.equal((definition.parameters as { additionalProperties?: unknown }).additionalProperties, false);
    assert.ok(definition.description.length > 0);
  }
});

test("spawn validation applies exact names, fork counts, NFC, profile and message bounds", () => {
  assert.deepEqual(validateSpawnAgentInput({ task_name: "review_auth", message: "Review it" }), {
    task_name: "review_auth",
    message: "Review it",
  });
  assert.equal(validateSpawnAgentInput({ task_name: "x", message: "m", fork_turns: "100000", reasoning_effort: "xhigh" }).fork_turns, "100000");
  assert.equal(validateSpawnAgentInput({ task_name: "x", message: "m", fork_turns: "all" }).fork_turns, "all");
  assert.equal(validateSpawnAgentInput({ task_name: "x", message: "m", fork_turns: "0" }).fork_turns, "none");
  for (const value of ["01", "100001", "+1", "-1"]) {
    assert.throws(() => validateSpawnAgentInput({ task_name: "x", message: "m", fork_turns: value }), /fork_turns/);
  }
  assert.throws(() => validateSpawnAgentInput({ task_name: "é", message: "m" }), /invalid characters/);
  assert.throws(() => validateSpawnAgentInput({ task_name: "x", message: "   " }), /blank/);
  assert.throws(() => validateSpawnAgentInput({ task_name: "x", message: "m", extra: true }), /unknown/);
});

test("message, wait, interrupt and list validators are closed and bounded", () => {
  assert.deepEqual(validateTargetMessageInput({ target: "/root/a", message: "info" }), { target: "/root/a", message: "info" });
  assert.deepEqual(validateTargetInput({ target: "agt_abcdefghijklmnopqrstuv" }), { target: "agt_abcdefghijklmnopqrstuv" });
  assert.deepEqual(validateListSubagentModelsInput({ query: "grok" }), { query: "grok" });
  assert.deepEqual(validateListSubagentRolesInput({ query: "review" }), { query: "review" });
  assert.throws(() => validateListSubagentModelsInput({}), /missing required/);
  assert.throws(() => validateListSubagentRolesInput({ query: "" }), /1..256/);
  assert.deepEqual(validateListAgentsInput({}), {});
  assert.deepEqual(validateListAgentsInput({ path_prefix: "/root/a" }), { path_prefix: "/root/a" });
  assert.deepEqual(validateWaitAgentsInput({ targets: ["/root/a", "/root/b"] }), { targets: ["/root/a", "/root/b"] });
  assert.throws(() => validateWaitAgentsInput({ targets: [] }), /1..32/);
  assert.throws(() => validateWaitAgentsInput({ targets: ["a", "a"] }), /unique/);
  assert.throws(() => validateTargetInput(Object.create({ target: "a" })), /plain object/);
});

test("Host error catalog is complete and unique", () => {
  assert.equal(HOST_ERROR_CODES.length, 38);
  assert.equal(new Set(HOST_ERROR_CODES).size, HOST_ERROR_CODES.length);
  assert.ok(HOST_ERROR_CODES.includes("storage-capacity"));
  assert.ok(HOST_ERROR_CODES.includes("operation-expired"));
});

test("wait_agents arms only from a standalone tool-call message", () => {
  const context = (content: unknown[]) => ({ sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content } }] } }) as any;
  const wait = { type: "toolCall", id: "wait-1", name: "wait_agents", arguments: { targets: ["/root/a"] } };
  assert.equal(waitAgentsIsStandaloneV1(context([wait]), "wait-1"), true);
  assert.equal(waitAgentsIsStandaloneV1(context([{ type: "toolCall", id: "read-1", name: "read", arguments: {} }, wait]), "wait-1"), false);
  assert.equal(waitAgentsIsStandaloneV1(undefined, "wait-1"), false);
});

test("mixed wait_agents batch is rejected before the Host arms a barrier", async () => {
  const tools: any[] = []; let executions = 0;
  registerCollaborationTools({ registerTool: (tool: unknown) => tools.push(tool) } as never, async () => { executions++; return { details: { version: 1, tool: "wait_agents", outcome: "ok", host_revision: 1, data: { state: "armed" } }, terminate: true } as never; });
  const wait = tools.find((tool) => tool.name === "wait_agents");
  const context = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }, { type: "toolCall", id: "wait-1", name: "wait_agents", arguments: { targets: ["/root/a"] } }] } }] } };
  const result = await wait.execute("wait-1", { targets: ["/root/a"] }, undefined, undefined, context);
  assert.equal(result.details.outcome, "rejected"); assert.equal(result.terminate, undefined); assert.equal(executions, 0);
});

test("invalid tool arguments are rejected as a tool result instead of throwing", async () => {
  const tools: any[] = [];
  registerCollaborationTools({ registerTool: (tool: unknown) => tools.push(tool) } as never, async () => ({ details: { version: 1, tool: "send_input", outcome: "ok", host_revision: 1, data: {} } }) as never);
  const send = tools.find((tool) => tool.name === "send_input");
  assert.doesNotThrow(() => send.prepareArguments({ target: "", message: "" }));
  const result = await send.execute("call-1", { target: "", message: "" }, undefined, undefined, undefined);
  assert.equal(result.details.outcome, "rejected");
  assert.equal(result.details.error.code, "invalid-arguments");
  assert.equal(result.terminate, undefined);
});

test("Pi 1.5 pi-schema validates prepared arguments before the semantic safety guards", async () => {
  const tools: any[] = []; let executions = 0;
  registerCollaborationTools({ registerTool: (tool: unknown) => tools.push(tool) } as never, async ({ tool }) => {
    executions++;
    return { details: { version: 1, tool, outcome: "ok", host_revision: 0, data: {} } };
  });
  const prepare = (name: string, args: unknown) => {
    const tool = tools.find(tool => tool.name === name);
    assert.equal(tool.prepareArguments(args), args);
    return validateToolArguments(tool, { id: "schema", type: "toolCall", name, arguments: tool.prepareArguments(args) });
  };
  for (const [name, args] of [
    ["spawn_agent", { task_name: "x", message: "m", task_timeout_ms: 0 }],
    ["spawn_agent", { task_name: "x", message: "m", unknown: true }],
    ["send_input", { target: "x" }],
    ["wait_agents", { targets: [] }],
    ["wait_agents", { targets: Array.from({ length: 33 }, (_, index) => `x${index}`) }],
  ] as const) assert.throws(() => prepare(name, args), /Validation failed/);
  for (const args of [
    { task_name: "../escape", message: "m" },
    { task_name: "x", message: " " },
    { task_name: "x", message: "m", fork_turns: "01" },
  ]) {
    const spawn = tools.find(tool => tool.name === "spawn_agent");
    const result = await spawn.execute("schema", prepare("spawn_agent", args));
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "invalid-arguments");
  }
  assert.equal(executions, 0);
});

test("public model and role queries accept tab/newline/CR for exact matches and word search", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "subagents-query-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools: any[] = [];
  registerCollaborationTools({ registerTool: (tool: unknown) => tools.push(tool) } as never, async ({ tool, params, context }) => ({
    details: { version: 1, tool, outcome: "ok", host_revision: 0, data: await localCollaborationQuery(tool, params, context, directory) },
  }));
  const context = {
    cwd: directory, isProjectTrusted: () => false, scopedModels: [],
    modelRegistry: { getAvailable: () => [{ provider: "alternate", id: "gpt-6.1-sol" }, { provider: "alternate", id: "gpt-6.1-sol-extra" }] },
  };
  const cases = [
    ["list_subagent_models", "\tALTERNATE/GPT-6.1-SOL\r\n", ["alternate/gpt-6.1-sol"]],
    ["list_subagent_models", "alternate\tsol\n", ["alternate/gpt-6.1-sol", "alternate/gpt-6.1-sol-extra"]],
    ["list_subagent_roles", "\tEXPLORER\r\n", ["explorer"]],
    ["list_subagent_roles", "read\nexplorer\t", ["explorer"]],
  ] as const;
  for (const [name, query, expected] of cases) {
    const tool = tools.find((tool) => tool.name === name);
    const result = await tool.execute("query-call", tool.prepareArguments({ query }), undefined, undefined, context);
    assert.equal(result.isError, undefined, query);
    assert.equal(result.details.outcome, "ok");
    const data = result.details.data;
    assert.deepEqual(name === "list_subagent_models" ? data.models : data.roles.map((role: { name: string }) => role.name), expected);
  }
});

test("public model and role queries still reject other controls and preserve byte bounds", async () => {
  const tools: any[] = []; let executions = 0;
  registerCollaborationTools({ registerTool: (tool: unknown) => tools.push(tool) } as never, async ({ tool }) => {
    executions++;
    return { details: { version: 1, tool, outcome: "ok", host_revision: 0, data: {} } };
  });
  const controls = Array.from({ length: 32 }, (_, code) => code).filter((code) => ![9, 10, 13].includes(code))
    .concat(Array.from({ length: 33 }, (_, index) => index + 127));
  for (const name of ["list_subagent_models", "list_subagent_roles"]) {
    const tool = tools.find((tool) => tool.name === name);
    for (const query of [...controls.map((code) => `a${String.fromCharCode(code)}b`), "", "x".repeat(257)]) {
      const result = await tool.execute("query-call", { query });
      assert.equal(result.isError, true);
      assert.equal(result.details.error.code, "invalid-arguments");
    }
    assert.equal((await tool.execute("query-call", { query: "x".repeat(256) })).isError, undefined);
  }
  assert.equal(executions, 2);
  assert.throws(() => validateSpawnAgentInput({ task_name: "x", message: "m", model: "alternate\tsol" }), /control characters/);
});

test("rejected collaboration results are flagged isError and lead with the error code", async () => {
  const tools: any[] = [];
  registerCollaborationTools({ registerTool: (tool: unknown) => tools.push(tool) } as never, async () => ({ details: { version: 1, tool: "spawn_agent", outcome: "rejected", host_revision: 1, error: { code: "name-conflict", message: "an Agent named x already exists under /root" } } }) as never);
  const spawn = tools.find((tool) => tool.name === "spawn_agent");
  const result = await spawn.execute("call-1", { task_name: "x", message: "m" }, undefined, undefined, undefined);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "name-conflict: an Agent named x already exists under /root");
  const send = tools.find((tool) => tool.name === "send_input");
  const invalid = await send.execute("call-2", { target: "", message: "" }, undefined, undefined, undefined);
  assert.equal(invalid.isError, true);
  const ok = tools.find((tool) => tool.name === "list_agents");
  registerCollaborationTools({ registerTool: (tool: unknown) => tools.push(tool) } as never, async () => ({ details: { version: 1, tool: "list_agents", outcome: "ok", host_revision: 1, data: { agents: [] } } }) as never);
  const good = await tools.filter((tool) => tool.name === "list_agents").at(-1).execute("call-3", {}, undefined, undefined, undefined);
  assert.equal(good.isError, undefined); assert.equal(ok.name, "list_agents");
});


test("send/close exact boolean schemas and child registration exclude Main lifecycle tools", () => {
  assert.deepEqual(validateSendInput({target:"/root/a",message:"go",interrupt:true}),{target:"/root/a",message:"go",interrupt:true});
  for (const value of ["true",1,null]) { assert.throws(()=>validateSendInput({target:"a",message:"go",interrupt:value})); assert.throws(()=>validateCloseAgentInput({target:"a",force:value})); }
  assert.throws(()=>validateSendInput({target:"a",message:"",interrupt:true}));assert.throws(()=>validateCloseAgentInput({target:"a",unknown:true}));
  const definitions: any[]=[];registerCollaborationTools({registerTool:(definition:any)=>definitions.push(definition)} as any,undefined,false,false);
  for (const name of ["spawn_agent","resume_agent","close_agent","send_message","followup_task","interrupt_agent","kill_agent"]) assert.ok(!definitions.some(d=>d.name===name));
});
