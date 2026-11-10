import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { assertProbes } from "../internals.ts";
import { SIDE_VISIBILITY_PROBES } from "../compat/pi-1.2-side-visibility.ts";

export default function checkSideChatInternals(_pi: ExtensionAPI): void {
  assertProbes(SIDE_VISIBILITY_PROBES);
  const reportFile = process.env.PI_SIDECHAT_PROBE_REPORT;
  if (!reportFile) throw new Error("PI_SIDECHAT_PROBE_REPORT is required");
  writeFileSync(reportFile, JSON.stringify({ ok: true, version: VERSION, probes: SIDE_VISIBILITY_PROBES.map(probe => probe.id) }) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" });
}
