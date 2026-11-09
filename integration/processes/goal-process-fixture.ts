import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getSystemMessageText, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getProcessServiceCellV1 } from "../../local/pi-subagents/src/host/service-cell.ts";

export default function (pi: ExtensionAPI) {
  const root = process.env.PI_PROCESS_GOAL_ROOT!, scenario = process.env.PI_PROCESS_GOAL_SCENARIO!;
  const log = (value: unknown) => appendFileSync(join(root, "events.jsonl"), JSON.stringify(value) + "\n");
  let ctx: ExtensionContext;
  pi.on("session_start", (_event, current) => { ctx = current; });
  pi.on("agent_settled", async () => {
    if (process.env.PI_PROCESS_GOAL_CHILD === "1") {
      const binding = getProcessServiceCellV1().service?.binding(ctx.sessionManager.getSessionId());
      const entries = [];
      for (const item of binding?.host.snapshot().agents ?? []) {
        const child = await binding!.runtime.childForView(item.agent.agent_id);
        if (child) entries.push(...child.session.sessionManager.getEntries());
      }
      log({ stage: "children", calls: entries.filter(e => e.type === "message" && e.message.role === "assistant").length,
        batches: entries.filter(e => e.type === "custom_message" && e.customType === "process-notification-batch-v1").length });
    }
    log({ stage: "settled", calls: faux.state.callCount });
  });
  const faux = fauxProvider({ provider: "goal-process-faux", api: "goal-process-faux", models: [{ id: "fixture", contextWindow: 64000, maxTokens: 1024 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 8 }, () => context => {
    log({ stage: "request", call: faux.state.callCount, messages: context.messages });
    if (faux.state.callCount === 1) return fauxAssistantMessage("FIXTURE_READY");
    if (faux.state.callCount === 2 && process.env.PI_PROCESS_GOAL_CHILD === "1") return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "goal-child", message: "PROCESS_PARENT", fork_turns: "none", agent_type: "default", model: "fixture/faux-1", reasoning_effort: "off" }), { stopReason: "toolUse" });
    if (faux.state.callCount === 2) return fauxAssistantMessage(fauxToolCall("process", { action: "start", name: "goal-wait", command: "while [ ! -f '" + join(root, "gate") + "' ]; do sleep 0.02; done; printf DONE", continuation: { mode: "wait", until: { kind: "exit" } } }), { stopReason: "toolUse" });
    if (faux.state.callCount === 3) return fauxAssistantMessage("WAITING");
    if (faux.state.callCount === 4) {
      if (scenario.startsWith("paused")) return fauxAssistantMessage("PAUSED_RESULT_RECORDED");
      const texts = context.messages.flatMap(message => message.role === "system" ? [getSystemMessageText(message)] : typeof message.content === "string" ? [message.content] : message.content.flatMap(block => block.type === "text" ? [block.text] : []));
      const id = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/.exec(texts.join("\n"))?.[1];
      if (!id) throw new Error("missing Goal ID");
      return fauxAssistantMessage(fauxToolCall("goal_complete", { goal_id: id, summary: "Process result verified" }));
    }
    throw new Error("duplicate provider request");
  }));
  pi.registerProvider(faux.provider);
}
