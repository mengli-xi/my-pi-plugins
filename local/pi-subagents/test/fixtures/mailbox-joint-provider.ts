import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/** Deterministic real-provider responses for B × C × D; no external requests. */
export async function mailboxJointResponse(pi: any, context: any, options: any) {
  if (process.env.PI_MAILBOX_JOINT !== "1") return undefined;
  const root = process.env.PI_SUBAGENTS_HOST_CONTROL!;
  const text = (content: any) => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
  const lastUser = [...context.messages].reverse().find(message => message.role === "user");
  if (text(lastUser?.content) === "JOINT_CHILD") {
    writeFileSync(join(root, "joint-child-ready"), "ready");
    while (!existsSync(join(root, "joint-child-release")) && !options?.signal?.aborted) await new Promise(resolve => setTimeout(resolve, 10));
    return fauxAssistantMessage("JOINT_CHILD_DONE");
  }
  const all = String(context.systemPrompt) + "\n" + context.messages.map((message: any) => text(message.content)).join("\n");
  if (all.includes("JOINT_TRIPLE")) {
    const goal = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/u.exec(all)?.[1];
    if (all.includes("<subagent_completion") && all.includes("PROCESS_PARENT_DONE") && goal)
      return fauxAssistantMessage(fauxToolCall("goal_complete", { goal_id: goal, summary: "Observed the completed child Process result." }, { id: "triple-complete" }), { stopReason: "toolUse" });
    if (context.messages.some((message: any) => message.role === "assistant" && message.content?.some?.((part: any) => part.type === "toolCall" && part.name === "spawn_agent")))
      return fauxAssistantMessage("TRIPLE_WAITING");
    return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "process_parent", message: "PROCESS_PARENT", fork_turns: "none", model: "fixture/faux-1", reasoning_effort: "off" }, { id: "triple-spawn" }), { stopReason: "toolUse" });
  }
  if (!all.includes("JOINT_GOAL")) return undefined;
  const last = context.messages.at(-1);
  if (last?.role === "toolResult" && last.toolName === "goal_complete") return fauxAssistantMessage("JOINT_DONE");
  const card = all.includes("<subagent_completion") && all.includes("JOINT_CHILD_DONE");
  const processSeen = all.includes("Process 'joint_process' succeeded");
  const goal = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/u.exec(all)?.[1];
  appendFileSync(join(root, "joint-decisions.jsonl"), JSON.stringify({ card, processSeen, goal, paused: all.includes("Paused-goal rules:"), goalTool: pi.getActiveTools().includes("goal_complete"), tail: all.slice(-250) }) + "\n");
  if (card && processSeen) {
    if (!all.includes("Paused-goal rules:") && goal && pi.getActiveTools().includes("goal_complete"))
      return fauxAssistantMessage(fauxToolCall("goal_complete", { goal_id: goal, summary: "Both real producer results were observed." }, { id: "joint-complete" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("JOINT_RECORDED");
  }
  const spawned = context.messages.some((message: any) => message.role === "assistant" && message.content?.some?.((part: any) => part.type === "toolCall" && part.name === "spawn_agent"));
  if (!spawned) {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const ready = quote(join(root, "joint-process-ready")), release = quote(join(root, "joint-release"));
    return fauxAssistantMessage([
      fauxToolCall("spawn_agent", { task_name: "joint_child", message: "JOINT_CHILD", fork_turns: "none", model: "fixture/faux-1", reasoning_effort: "off" }, { id: "joint-spawn" }),
      fauxToolCall("process", { action: "start", name: "joint_process", kind: "process", command: `touch ${ready}; while [ ! -f ${release} ]; do sleep 0.02; done; printf JOINT_PROCESS_DONE`, watches: [], continuation: { mode: "wait", until: { kind: "exit" } } }, { id: "joint-process" }),
    ], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("JOINT_WAITING");
}
