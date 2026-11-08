import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export default function fixture(pi: ExtensionAPI) {
  const root = process.env.PI_SUBAGENTS_HOST_CONTROL!;
  process.env.TMPDIR = root; // Isolate Supervisor logs and its startup scavenger.
  let compacting = false, serial = 0;
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "faux-1", name: "Compact Faux", reasoning: false, contextWindow: 128000, maxTokens: 1024 }] });
  faux.setResponses(Array.from({ length: 100 }, () => async context => {
    appendFileSync(join(root, "compact-requests.jsonl"), JSON.stringify({ compacting, messages: context.messages }) + "\n");
    if (compacting) return existsSync(join(root, "compact-release")) && readFileSync(join(root, "compact-release"), "utf8") === "failed" ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "FAUX_COMPACT_FAILURE" }) : fauxAssistantMessage(`NATIVE_SUMMARY_${++serial}`);
    const text = JSON.stringify(context.messages);
    if (text.includes("REINJECT_SETUP") && !text.includes('"toolName":"spawn_agent"')) return fauxAssistantMessage([
      fauxToolCall("spawn_agent", { task_name: "compact_child", message: "COMPACT_REINJECT_CHILD", fork_turns: "none" }, { id: "spawn-compact" }),
      fauxToolCall("process", { action: "start", name: "compact_process", command: `while [ ! -f '${root}/child-release' ]; do sleep 0.05; done; printf PROCESS_COMPACT_DONE`, notify: { onSuccess: "turn" } }, { id: "process-compact" }),
    ], { stopReason: "toolUse" });
    if (text.includes("REINJECT_ACTIVE") && !text.includes('"toolName":"compact_fill"')) return fauxAssistantMessage(fauxToolCall("compact_fill", {}, { id: "fill" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("MAIN_OK");
  }));
  pi.registerProvider(faux.provider);
  pi.registerTool({ name: "compact_fill", label: "Fill", description: "Test threshold compaction", parameters: { type: "object", properties: {} } as never, async execute() { return { content: [{ type: "text", text: "x".repeat(300000) }], details: undefined }; } });
  pi.on("session_before_compact", async event => {
    compacting = true;
    writeFileSync(join(root, "compact-entered"), "yes");
    while (!existsSync(join(root, "compact-release"))) {
      if (event.signal.aborted) return { cancel: true };
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const mode = readFileSync(join(root, "compact-release"), "utf8");
    if (mode === "cancel") return { cancel: true };
    if (mode === "extension") return { compaction: { summary: `EXT_SUMMARY_${++serial}`, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on("session_compact", () => { compacting = false; });
  pi.on("session_compact_failed", () => { compacting = false; });
}
