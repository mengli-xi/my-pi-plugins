/**
 * Putting internals drift in front of the user.
 *
 * Two surfaces, deliberately different:
 *
 * - **Pushed**, when a patch has actually broken. One collapsed transcript row
 *   with the detail behind a click, shown once per (pi version × problem set),
 *   so a still-broken patch does not nag every session.
 * - **Asked**, through `/internals`. The full table, including the probes that
 *   are merely `unexercised` — the state that is normal right after an upgrade
 *   and would be pure noise if pushed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  auditInternals,
  consumeNewDrift,
  currentPiVersion,
  declareProbes,
  flushInternalsHealth,
  renderDriftReport,
  summariseDrift,
  type ProbeRow,
} from "./internals.ts";
import { ALL_PROBES } from "./probes.ts";

const CUSTOM_TYPE = "internals";

/**
 * Pure display reports explicitly use triggerTurn:false in busy and idle runs.
 * `details` as a plain string rather than `{ markdown }`.
 *
 * `command-output.ts` sends a string straight through to the popup, and this
 * report is a fixed-width table: rendering it as Markdown would collapse the
 * indentation that carries its structure.
 */
function send(pi: ExtensionAPI, rows: ProbeRow[], version: string): void {
  void Promise.resolve()
    .then(() =>
      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: summariseDrift(rows, version),
        display: true,
        details: renderDriftReport(rows, version),
      }, { triggerTurn: false }),
    )
    .catch(() => {
      // The session went away mid-report. The state is on disk; the next
      // session start will find the same fingerprint unreported and retry.
    });
}

/**
 * Report drift if there is any new drift to report.
 *
 * Safe to call from anywhere that is not inside a render: it reads the store,
 * which is in memory after the first call.
 */
export function reportDriftIfAny(pi: ExtensionAPI): void {
  const version = currentPiVersion();
  const drift = consumeNewDrift(version);
  if (drift) send(pi, drift.rows, version);
}

/**
 * Wire up drift reporting and the `/internals` command.
 *
 * The polling points are session start (catches anything a previous session
 * recorded) and agent end (catches what broke during this one, at a moment
 * when no frame is being drawn).
 */
export function installInternalsMonitor(pi: ExtensionAPI): void {
  pi.on("session_start", () => reportDriftIfAny(pi));
  pi.on("agent_end", () => reportDriftIfAny(pi));
  pi.on("session_shutdown", async () => {
    await flushInternalsHealth();
  });

  pi.registerCommand("internals", {
    description: "Show which pi internals this extension depends on, and their health",
    handler: async (_args: string, _ctx: ExtensionContext) => {
      // Everything, not just what is installed: the question being asked is
      // "what does this package depend on", and a disabled feature's
      // dependencies are still the answer.
      declareProbes(ALL_PROBES);
      const version = currentPiVersion();
      const rows = auditInternals(version);
      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: summariseDrift(rows, version),
        display: true,
        details: renderDriftReport(rows, version),
      }, { triggerTurn: false });
    },
  });
}
