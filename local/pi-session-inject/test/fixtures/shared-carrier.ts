import type { Mail, ProducerId } from "../../src/mailbox-v1/light.js";

/** D intentionally accepts the same Completion carrier under card and Outbox
 * keys. Keep both public Main and SDK child formats, without importing D. */
export function sharedCarrierFixture(format: "generic" | "main" | "child"): {
  producer: ProducerId; keys: readonly [string, string]; messages: Mail["messages"];
} {
  if (format === "generic") return { producer: "pi-processes", keys: ["keep", "discard"],
    messages: [{ customType: "fixture-body", content: "SHARED_CARRIER", display: false, details: { identity: "shared" } }] };
  const inboxId = "inbox-shared", completionId = "completion-shared", projectionSha256 = "a".repeat(64);
  const completion = { task_id: "task-shared", outcome: "success" };
  return { producer: "pi-subagents", keys: ["card:inbox-shared", format === "main" ? "outbox:outbox-shared:1" : "agent:agent-shared:task:task-shared:gen:1:outbox:outbox-shared:1"],
    messages: [{ customType: "subagent-completion-v1", content: "SHARED_COMPLETION_CARD", display: true,
      details: format === "main"
        ? { version: 1, inbox_id: inboxId, completion_id: completionId, projection_sha256: projectionSha256, details_json: JSON.stringify(completion) }
        : { inbox_id: inboxId, completion_id: completionId, projection_sha256: projectionSha256, completion_details: completion } }] };
}
