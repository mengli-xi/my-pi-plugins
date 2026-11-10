/**
 * `npm run check:internals` — does the installed pi still have the names this
 * package patches?
 *
 * Answers the eager half of the question without a session: prototype methods
 * and exported classes, checked against whatever `@earendil-works/pi-coding-agent`
 * resolves to right now. Run it after upgrading pi; a clean exit means no
 * prototype in that source graph has gone missing. It does not validate the
 * final Bun bundle; follow it with `check:host` against that binary.
 *
 * It cannot see instance fields — `this.box`, `this.chatContainer`, `Text`'s
 * own `text`. Those need a live component, so they are reported from the patch
 * bodies during a session and shown by `/internals`.
 */

import { auditInternals, declareProbes, type ProbeRow } from "../src/internals.ts";
import { ALL_PROBES } from "../src/probes.ts";
import { VERSION } from "@earendil-works/pi-coding-agent";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

declareProbes(ALL_PROBES);

// Eager checks only: a stored `unexercised`/`ok` from some session says nothing
// about the pi that is installed right now, which is the whole question here.
const rows: ProbeRow[] = auditInternals(VERSION).filter((row) => row.check);
const missing = rows.filter((row) => row.state === "missing");

console.log(`pi ${VERSION} · ${rows.length} 个可离线检查的内部依赖\n`);
for (const row of rows) {
  const ok = row.state !== "missing";
  const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`${mark} ${row.id}`);
  console.log(`  ${DIM}${row.needs}${RESET}`);
  if (!ok) {
    console.log(`  ${RED}影响${RESET} ${row.breaks}`);
    if (row.detail) console.log(`  ${RED}详情${RESET} ${row.detail}`);
  }
}

const instanceOnly = ALL_PROBES.filter((probe) => !probe.check);
console.log(
  `\n${DIM}另有 ${instanceOnly.length} 个实例字段依赖只能在会话中检测，见 /internals${RESET}`,
);

if (missing.length > 0) {
  console.error(`\n${RED}${missing.length} 个内部依赖已消失${RESET}`);
  process.exit(1);
}
console.log(`\n${GREEN}全部就位${RESET}`);
