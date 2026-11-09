import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessMainBindingV1 } from "../../src/host/process-service.js";
import { getProcessServiceCellV1 } from "../../src/host/service-cell.js";

function registerTestCommands(pi: ExtensionAPI, ensureForContext: (ctx: ExtensionContext) => Promise<ProcessMainBindingV1>): void {
  pi.registerCommand("subagents-test-followup", { description: "Isolated follow-up contract hook", async handler(_args, ctx) { const binding = await ensureForContext(ctx); if (!binding) throw new Error("Subagent test binding is unavailable"); const agent = binding.host.snapshot().agents[0]; if (!agent) throw new Error("No Subagent exists"); const result = await binding.host.followupTask({ request_id: crypto.randomUUID(), caller: { kind: "user", main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 }, input: { target: agent.agent.task_path, message: process.env.PI_SUBAGENTS_TEST_FOLLOWUP ?? "Reply FOLLOWUP_OK" } }); if (!result.ok) throw new Error(result.error.message); } }); pi.registerCommand("subagents-test-send", { description: "Isolated mailbox delivery hook", async handler(_args, ctx) { const binding = await ensureForContext(ctx); if (!binding) throw new Error("Subagent test binding is unavailable"); const agent = binding.host.snapshot().agents[0]; if (!agent) throw new Error("No Subagent exists"); const result = await binding.host.sendInput({ request_id: crypto.randomUUID(), caller: { kind: "user", main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 }, input: { target: agent.agent.task_path, message: process.env.PI_SUBAGENTS_TEST_MAILBOX ?? "MAILBOX_NOTE" } }); if (!result.ok) throw new Error(result.error.message); const recipient = (result.value as { recipient?: { agent_id?: string } }).recipient; if (recipient?.agent_id) { await binding.host.synthesizeMailboxDelivery({ agentId: recipient.agent_id as never, at: new Date().toISOString() }); await binding.runtime.flushAgent(recipient.agent_id as never); } } }); pi.registerCommand("subagents-test-spawn", { description: "Isolated real-runtime contract hook", async handler(_args, ctx) { const cell = getProcessServiceCellV1(); const binding = await ensureForContext(ctx); if (!binding) throw new Error("Subagent test binding is unavailable"); const request_id = crypto.randomUUID(); const release = binding.preparation.bind(request_id, ctx); let spawned; try { spawned = await binding.host.spawnAgent({ request_id, caller: { kind: "main-model", conversation: { kind: "main", session_id: binding.mainSessionId }, binding_generation: binding.bindingGeneration }, input: { task_name: process.env.PI_SUBAGENTS_TEST_TASK_NAME ?? "real_spawn", message: process.env.PI_SUBAGENTS_TEST_MESSAGE ?? "Reply exactly SUBAGENT_OK and do not call any tools.", fork_turns: "none", agent_type: "default", model: `${ctx.model?.provider}/${ctx.model?.id}`, reasoning_effort: ctx.thinkingLevel ?? "off" } }); } finally { release(); } if (!spawned.ok) throw new Error(spawned.error.message); if(process.env.PI_SUBAGENTS_TEST_ASYNC==="1")return; const deadline = Date.now() + Number(process.env.PI_SUBAGENTS_TEST_TIMEOUT_MS ?? 90_000); let terminal; while (Date.now() < deadline) { const snapshot = binding.host.snapshot(); const partition = snapshot.agents.find((item) => item.agent.agent_id === spawned.value.agent_id); const task = partition?.tasks.find((item) => item.task_id === spawned.value.task_id); const outbox = partition?.outbox.find((item) => item.completion_ids.includes(task?.completion_id as never)); if (task?.phase === "settled" && outbox?.state === "delivered") { terminal = { task, outbox, completion: partition?.completions.find((item) => item.completion_id === task.completion_id) }; break; } await new Promise((resolve) => setTimeout(resolve, 20)); } if (!terminal) { const snapshot = binding.host.snapshot(); const ownerHealth = await cell.service?.health().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })); const agent = snapshot.agents.find((item) => item.agent.agent_id === spawned.value.agent_id); let childSession = ""; try { childSession = (await readFile(join(binding.store.mainRoot, agent!.agent.conversation.relative_path), "utf8")).slice(-16_384); } catch {} throw new Error(`Subagent test Task did not reach terminal delivery: ${JSON.stringify({ revision: snapshot.root.host_revision, ownerHealth, childSessionBase64: Buffer.from(childSession).toString("base64"), agents: snapshot.agents.map((item) => ({ agent: item.agent, tasks: item.tasks, completions: item.completions, ownerEvents: item.owner_events, outbox: item.outbox })) })}`); } } });
}
/** Test-only wrapper: initialize through an existing tool, then read the existing owner cell. */
export async function installTestCommands(pi: ExtensionAPI, owner: ExtensionFactory): Promise<void> {
  let initialize: ((ctx: ExtensionContext) => ReturnType<ToolDefinition["execute"]>) | undefined;
  await owner({ ...pi, registerTool(definition) {
    if (definition.name === "list_agents") initialize = ctx => definition.execute(crypto.randomUUID(), {} as never, undefined, undefined, {
      ...ctx, tools: [], executeTool: async () => { throw new Error("Test initialization cannot execute nested tools"); },
    });
    pi.registerTool(definition);
  } });
  let generation = 0, active = false;
  pi.on("session_start", () => { generation++; active = true; });
  pi.on("session_shutdown", () => { generation++; active = false; });
  registerTestCommands(pi, async ctx => {
    if (!active || !initialize) throw new Error("Subagent test session is unavailable");
    const expectedGeneration = generation;
    const result = await initialize(ctx);
    if (!active || generation !== expectedGeneration) throw new Error("Subagent test session changed");
    if (result.isError) throw new Error(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
    const binding = getProcessServiceCellV1().service?.binding(ctx.sessionManager.getSessionId());
    if (!binding) throw new Error("Subagent test binding is unavailable");
    return binding;
  });
}
export default async function testCommands(pi: ExtensionAPI): Promise<void> {
  const owner = await import(new URL("../../dist/index.js", import.meta.url).href);
  await installTestCommands(pi, owner.default);
}
