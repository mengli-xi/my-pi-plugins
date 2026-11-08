import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TerminalEvidence } from "pi-session-inject/mailbox-v1";
// @ts-expect-error The real compiled extension intentionally emits no declarations.
import { SubagentMailboxTransport } from "../../dist/mailbox/transport.js";
export default function coldSource(pi: ExtensionAPI) {
  const source = new SubagentMailboxTransport(pi, process.env.PI_CODING_AGENT_DIR!, {
    checkCurrent: () => ({ kind: "allow", project: true, wake: true }),
    onTerminal: (evidence: TerminalEvidence) => {
      if (process.env.PI_MAILBOX_TEST_ACK_LOST === "1") throw new Error("injected source final ACK loss");
      pi.appendEntry("subagent-test-terminal-ack", { terminalId: evidence.terminalId, outcome: evidence.outcome });
    },
  });
  pi.on("agent_settled", (_event, ctx) => { writeFileSync(join(ctx.cwd, "mailbox-fixture-settled"), "yes"); });
  pi.on("session_start", async () => {
    const content = "FOREGROUND_CHECK";
    await source.put({ key: "mail:cold-fixture", recovered: true, wake: true,
      messages: [{ customType: "subagent-mailbox-v1", content, display: true,
        details: { message_id: "cold-fixture", body_sha256: createHash("sha256").update(content).digest("hex"), injected_into: { kind: "idle-conversation" } } }] });
  });
}
