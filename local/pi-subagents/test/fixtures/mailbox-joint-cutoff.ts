import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// First CLI fixture: only reads the published atomic snapshot, before A seals.
// No producer/transport monkey-patch and no business work is simulated here.
export default function jointCutoff(pi: ExtensionAPI): void {
  if (process.env.PI_MAILBOX_JOINT !== "1") return;
  const root = process.env.PI_SUBAGENTS_HOST_CONTROL!;
  let admitted: Array<{ producer: string; key: string }> | undefined;
  let checked = false;
  let businessRequestsBefore = 0;
  const snapshot = async (ctx: ExtensionContext): Promise<any> => {
    try { return JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR!, "mailbox/v1", ctx.sessionManager.getSessionId(), "pending.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  pi.on("before_agent_start", async (_event, ctx) => {
    if (admitted || !existsSync(join(root, "joint-release"))) return;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = await snapshot(ctx);
      assert.ok(!state?.attempt, "joint gate must run before A seals the first result attempt");
      const batch = state?.pending.find((mail: any) => mail.producer === "pi-processes" && mail.messages.some((m: any) => m.customType === "process-notification-batch-v1"));
      const card = state?.pending.find((mail: any) => mail.producer === "pi-subagents" && mail.messages.some((m: any) => m.customType === "subagent-completion-v1"));
      if (batch && card) {
        admitted = [batch, card].map(({ producer, key }) => ({ producer, key }));
        businessRequestsBefore = readFileSync(process.env.PI_SUBAGENTS_TEST_LOG!, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.sessionId === ctx.sessionManager.getSessionId() && !row.messages.some((m: any) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("You name coding sessions for a session picker."))).length;
        await writeFile(join(root, "joint-cutoff-accepted.json"), JSON.stringify({ beforeSeal: true, revision: state.revision, admitted }, null, 2));
        return;
      }
      assert.ok(Date.now() < deadline, "both real producers must durably accept before the first cutoff");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  pi.on("context", async (_event, ctx) => {
    if (!admitted || checked) return;
    const state = await snapshot(ctx), attempt = state?.attempt;
    assert.ok(attempt?.id, "first result request must have a sealed attempt");
    for (const member of admitted) assert.ok(attempt.members.some((m: any) => m.producer === member.producer && m.key === member.key), "first attempt must include both accepted sources");
    checked = true;
    await writeFile(join(root, "joint-cutoff.json"), JSON.stringify({ beforeSeal: true, admitted, businessRequestsBefore, firstAttempt: attempt, firstAttemptIncludesBoth: true }, null, 2));
  });
}
