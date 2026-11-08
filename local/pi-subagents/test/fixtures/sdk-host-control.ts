import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentProcessServiceV1 } from "../../src/host/process-service.js";

export default function control(pi: ExtensionAPI): void {
  pi.registerCommand("subagents-host-control", {
    description: "Isolated fresh-host fixture control (no arguments)",
    async handler(_args, ctx) {
      const root = process.env.PI_SUBAGENTS_HOST_CONTROL!;
      const command = JSON.parse(await readFile(join(root, "command.json"), "utf8"));
      const cell = (globalThis as any)[Symbol.for("pi.subagents.process-service.v1")] as { service?: SubagentProcessServiceV1 } | undefined;
      const service = cell?.service, binding = service?.binding(ctx.sessionManager.getSessionId());
      let result: unknown;
      if (command.op === "reload") {
        await ctx.reload(); result = { reloaded: true };
      } else if (command.op === "snapshot") {
        result = { service: !!service, mainId: ctx.sessionManager.getSessionId(), bindingGeneration: binding?.bindingGeneration,
          mainRoot: binding?.store.mainRoot, diagnostics: service?.diagnostics(), snapshot: binding?.host.snapshot(),
          residents: binding ? await Promise.all(binding.host.snapshot().agents.map(async item => {
            const child = await binding.runtime.childForView(item.agent.agent_id);
            return { agentId: item.agent.agent_id, residency: binding.runtime.residency(item.agent.agent_id), nativeSessionId: child?.session.sessionId, idle: child?.session.isIdle,
              generation: child?.identity.generation, compaction: child?.runtime.services.settingsManager.getCompactionSettings(child.session.model), activeTools: child?.session.getActiveToolNames() };
          })) : [] };
      } else {
        if (!service || !binding) throw new Error("SDK binding is unavailable");
        if (command.op === "user-input") {
          const agent = binding.host.snapshot().agents.find(item => item.agent.agent_id === command.target)!;
          await binding.runtime.admitViewInput(agent.agent.agent_id, { kind: "user", main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 }, String(command.params.message));
          result = { accepted: true };
        } else if (command.op === "reload-child" || command.op === "fail-child-reload") {
          const agent = binding.host.snapshot().agents.find(item => item.agent.agent_id === command.target)!;
          const child = (await binding.runtime.childForView(agent.agent.agent_id))!;
          if (command.op === "fail-child-reload") { await child.drain(); await binding.runtime.drainControl(agent.agent.agent_id); await new Promise<void>(resolve => setImmediate(resolve)); }
          const before = { generation: child.identity.generation, sessionId: child.session.sessionId };
          const conversation = child.conversation, runner = child.session.extensionRunner, ui = runner.getUIContext(), notices: string[] = [];
          const observedUI = { ...ui, notify: (message: string, type?: "info" | "warning" | "error") => { notices.push(message); ui.notify(message, type); } };
          runner.setUIContext(observedUI, "rpc");
          let reloadRefused = false, error: string | undefined;
          try { await child.session.reload(command.op === "fail-child-reload" ? { beforeSessionStart: async () => {
            child.session.extensionRunner.setUIContext(observedUI, "rpc");
            throw new Error("controlled native beforeSessionStart failure");
          } } : undefined); }
          catch (cause) { reloadRefused = true; error = cause instanceof Error ? cause.message : String(cause); }
          finally { if (child.session.extensionRunner === runner) runner.setUIContext(ui, "rpc"); }
          result = { before, after: { generation: child.identity.generation, sessionId: child.session.sessionId }, reloadRefused, error, notices,
            bindingUnchanged: child.conversation === conversation, nativeFailureRequested: command.op === "fail-child-reload" };
        } else if (command.op === "parallel-resume") {
          result = await Promise.all(command.params.targets.map((target: string) => binding.host.resumeAgent({ request_id: randomUUID(), caller: { kind: "user", main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 }, input: { target } })));
        } else if (command.op === "dispose-child") {
          const agent = binding.host.snapshot().agents.find(item => item.agent.task_name === command.target)!;
          await (await binding.runtime.childForView(agent.agent.agent_id))!.runtime.dispose(); result = { disposed: true };
        } else if (command.op === "retirement") {
          const { readMainMailboxRetirement } = await import(new URL("../../dist/mailbox/retirement-main.js", import.meta.url).href);
          const state = binding.host.snapshot(), facts = await readMainMailboxRetirement(binding.host.mainMailboxReadContext);
          result = state.agents.flatMap(item => item.outbox.map(outbox => ({ outboxId: outbox.outbox_id, kind: facts.outbox(state, outbox).kind })));
        } else if (command.op === "delete") {
          const agent = binding.host.snapshot().agents.find(item => item.agent.task_name === command.target)!;
          const { runAgentActionV1 } = await import(new URL("../../dist/ui/manager.js", import.meta.url).href);
          const before = binding.runtime.residency(agent.agent.agent_id);
          const message = await runAgentActionV1({ ui: { ...ctx.ui, confirm: async () => true } }, binding, agent.agent.agent_id, "delete");
          result = { message, before, after: binding.runtime.residency(agent.agent.agent_id) ?? null,
            exists: binding.host.snapshot().agents.some(item => item.agent.agent_id === agent.agent.agent_id) };
        } else if (command.op === "close") {
          const agent = binding.host.snapshot().agents.find(item => item.agent.task_name === command.target)!;
          const resident = binding.runtime.residency(agent.agent.agent_id)!;
          result = await binding.host.closeAgent({ request_id: randomUUID(), caller: { kind: "user", main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 }, input: { target: agent.agent.agent_id } });
        } else result = await service.executor(binding.mainSessionId)({ tool: command.op, toolCallId: "fixture", params: command.params, context: ctx });
      }
      await writeFile(join(root, "result.json"), JSON.stringify({ id: command.id, result }), { mode: 0o600 });
    },
  });
}
