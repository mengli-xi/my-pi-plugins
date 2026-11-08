// Stock-Pi fault gate: hold the first real source turn transaction after its
// whole-run observation is durable. The parent test SIGKILLs this process.
// This wraps our own Host instance, not Pi internals or a fake mailbox sender.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessMainBindingV1 } from "../../src/host/process-service.ts";
const SERVICE = Symbol.for("pi.subagents.process-service.v1");
interface Cell { service?: { binding(sessionId: string): ProcessMainBindingV1 | undefined } }

export default function mainTurnCommitCrash(pi: ExtensionAPI): void {
  if (!process.env.PI_MAIN_TURN_COMMIT_FAULT) return;
  let installed = false;
  pi.on("tool_execution_end", (_event, ctx) => {
    if (installed) return;
    const binding = (globalThis as typeof globalThis & { [SERVICE]?: Cell })[SERVICE]?.service?.binding(ctx.sessionManager.getSessionId());
    if (!binding) return;
    installed = true;
    binding.host.settleOutboxTurn = async input => {
      const branch = ctx.sessionManager.getBranch();
      writeFileSync(process.env.PI_MAIN_TURN_COMMIT_FAULT!, JSON.stringify({ input, branch, mainRoot: binding.store.mainRoot, snapshot: binding.host.snapshot() }), { mode: 0o600 });
      return await new Promise<never>(() => {});
    };
  });
}
