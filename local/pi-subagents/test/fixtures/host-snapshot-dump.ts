// Read-only test fixture for the real-Pi suites: writes the live production Host snapshot to
// PI_SUBAGENTS_SNAPSHOT_DUMP so a driver counts authoritative records instead of guessing the
// on-disk checkpoint layout (checkpoints lag the journal, so cp_* files are not authoritative
// mid-run). The service cell is reached through its published global symbol, so this fixture
// shares the one instance created by dist/index.js instead of loading a second copy of the host.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SERVICE = Symbol.for("pi.subagents.process-service.v1");
interface SnapshotBinding { readonly store: { readonly mainRoot: string }; readonly host: { snapshot(): unknown } }
interface Cell { service?: { binding(sessionId: string): SnapshotBinding | undefined } }

export default function hostSnapshotDump(pi: ExtensionAPI): void {
  pi.registerCommand("subagents-snapshot-dump", {
    description: "Dump the live pi-subagents Host snapshot to PI_SUBAGENTS_SNAPSHOT_DUMP",
    async handler(_args, ctx) {
      const target = process.env.PI_SUBAGENTS_SNAPSHOT_DUMP;
      if (!target) throw new Error("PI_SUBAGENTS_SNAPSHOT_DUMP is unset");
      const binding = (globalThis as typeof globalThis & { [SERVICE]?: Cell })[SERVICE]?.service?.binding(ctx.sessionManager.getSessionId());
      if (!binding) throw new Error("Subagent binding is unavailable");
      writeFileSync(target, JSON.stringify({ main_root: binding.store.mainRoot, at: new Date().toISOString(), snapshot: binding.host.snapshot() }), { mode: 0o600 });
    },
  });
}
