import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

/** Public context gate shared by the stock model factories; no product fault port. */
export function sdkReloadFixture(pi: ExtensionAPI) {
  if (process.env.PI_SDK_RELOAD_TEST !== "1") return undefined;
  const root = process.env.PI_SUBAGENTS_HOST_CONTROL!, path = (name: string) => join(root, name);
  let child = false;
  pi.on("session_start", (_event, ctx) => { child = ctx.sessionManager.getSessionFile()?.includes("/store-v2/") === true; });
  pi.on("context_with_system", async (_event, ctx) => {
    if (!child || !existsSync(path("sdk-gate-arm")) || existsSync(path("sdk-checkpoint.json"))) return;
    const kind = readFileSync(path("sdk-gate-arm"), "utf8"), file = ctx.sessionManager.getSessionFile()!;
    const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const native = [...entries].reverse().find(e => e.type === "custom_message" && (kind === "process"
      ? e.customType === "process-notification-batch-v1" : e.customType === "subagent-mailbox-v1" && e.content === "RELOAD_GATE_INPUT"));
    if (!native) return;
    writeFileSync(path("sdk-checkpoint.json"), JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), nativeEntryId: native.id, kind }), { mode: 0o600 });
    const deadline = Date.now() + 30_000;
    while (!existsSync(path("sdk-gate-release"))) { if (Date.now() >= deadline) throw new Error("SDK reload context gate was not released"); await new Promise(resolve => setTimeout(resolve, 10)); }
  });
  return async (context: any, options: any) => {
    if (!child) return fauxAssistantMessage("SDK_ROOT_HANDLED");
    const all = JSON.stringify(context.messages);
    if (all.includes("Process 'sdk-reload' succeeded")) return fauxAssistantMessage("SDK_PROCESS_SEEN");
    if (all.includes("RELOAD_GATE_INPUT") || all.includes("FULFILLED_BEFORE_RELOAD")) return fauxAssistantMessage("SDK_INPUT_SEEN");
    if (context.messages.some((m: any) => m.role === "toolResult" && m.toolName === "process")) return fauxAssistantMessage("SDK_WAITING");
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const command = `printf 'start\\n' >> ${quote(path("sdk-business.log"))}; while [ ! -f ${quote(path("sdk-process-release"))} ]; do sleep 0.02; done; printf 'exit\\n' >> ${quote(path("sdk-business.log"))}; printf SDK_PROCESS_DONE`;
    return fauxAssistantMessage(fauxToolCall("process", { action: "start", name: "sdk-reload", kind: "process", command, watches: [], continuation: { mode: "wait", until: { kind: "exit" } } }, { id: "sdk-start-process" }), { stopReason: "toolUse" });
  };
}
