/** Offline replay of explicit copies; no provider imports or network requests. */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { validateOutput } from "../src/output.ts";
import { collectUserQuotations, renderUserQuotations } from "../src/quotations.ts";
import { collectInventory, renderInventory } from "../src/inventory.ts";
import { restoredContext } from "../src/recovery.ts";
import { validRecoveryBound } from "../src/preflight.ts";
import { includesRecovery } from "../src/collected-recovery.ts";
const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) throw Error("Usage: node --experimental-strip-types scripts/replay-saved.mjs <copied-input-dir> <output-dir>");
const input = realpathSync(resolve(inputArg));
let existingOutput = resolve(outputArg);
while (!existsSync(existingOutput)) existingOutput = dirname(existingOutput);
const output = resolve(realpathSync(existingOutput), relative(existingOutput, resolve(outputArg)));
const inside = (path, root) => path === root || path.startsWith(root + sep);
for (const path of [input, output]) {
  if (/(?:^|\/)(?:\.pi|\.pi-next|\.pi-worker|store-v1)(?:\/|$)/.test(path)) throw Error(`Only copied input and offline output directories are allowed: ${path}`);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir && inside(path, existsSync(agentDir) ? realpathSync(agentDir) : resolve(agentDir))) throw Error(`Agent directory is not an offline replay directory: ${path}`);
}
if (inside(output, input)) throw Error("Output directory must be outside the read-only copied input directory");
for (const dir of ["sessions", "runs"]) if (!lstatSync(join(input, dir)).isDirectory() || lstatSync(join(input, dir)).isSymbolicLink()) throw Error(`Expected copied ${dir} directory, not a symlink`);
const readCopy = path => {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !inside(realpathSync(path), input)) throw Error(`Expected copied regular file: ${path}`);
  return readFileSync(path);
};
mkdirSync(output, { recursive: true, mode: 0o700 });
const sessions = new Map();
for (const name of readdirSync(join(input, "sessions"))) {
  const raw = readCopy(join(input, "sessions", name));
  const entries = raw.toString().trim().split("\n").filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw Error(`Copied session ${name}, line ${i + 1}: ${String(error)}`); }
  });
  const headers = entries.filter(e => e.type === "session"), header = headers[0];
  if (headers.length !== 1 || typeof header.id !== "string" || !header.id) throw Error(`Copied session ${name} must contain one session header with an id`);
  if (sessions.has(header.id)) throw Error(`Duplicate copied session id: ${header.id}`);
  sessions.set(header.id, { cwd: header.cwd, entries: entries.filter(e => e.type !== "session"), hash: createHash("sha256").update(raw).digest("hex") });
}
const ancestry = (entries, leaf) => {
  if (typeof leaf !== "string" || !leaf) throw Error("Frozen leaf is missing; no substitution.");
  const byId = new Map(entries.map(e => [e.id, e])), path = [], seen = new Set();
  for (let id = leaf; id;) {
    if (seen.has(id)) throw Error(`Cycle in frozen ancestry at ${id}`);
    if (!byId.has(id)) throw Error(`Frozen ancestry entry ${id} is absent from the persisted copy; no substitution.`);
    seen.add(id); const entry = byId.get(id); path.push(entry); id = entry.parentId;
  }
  return path.reverse();
};
const complete = attempt => ["stop", "toolUse"].includes(attempt.stopReason) && !!attempt.rawOutput?.trim();
const rows = [];
for (const name of readdirSync(join(input, "runs")).sort()) {
  let run;
  try { run = JSON.parse(readCopy(join(input, "runs", name)).toString()); } catch (error) { throw Error(`Copied run ${name}: ${String(error)}`); }
  const slot = run.outputs?.main;
  const row = { operationId: run.operationId, firstKeptEntryId: run.inputFingerprint?.firstKeptEntryId, attempts: [], firstResponseAccepted: false, savedResponseAccepted: false };
  if (!slot || !Array.isArray(slot.attempts)) { row.replayError = "Saved main slot or its attempts are missing"; rows.push(row); continue; }
  for (const [i, attempt] of slot.attempts.entries()) {
    const rendered = complete(attempt) ? validateOutput(attempt.rawOutput).summary : undefined;
    row.attempts.push({ index: i + 1, phase: attempt.phase, stopReason: attempt.stopReason, accepted: !!rendered, rawChars: attempt.rawOutput?.length ?? 0, renderedChars: rendered?.length ?? 0 });
  }
  row.firstResponseAccepted = row.attempts[0]?.accepted ?? false;
  const session = sessions.get(run.sessionId);
  let branch;
  try {
    if (!session) throw Error(`Copied session ${run.sessionId} is missing; no substitution.`);
    row.sessionCopySha256 = session.hash;
    branch = ancestry(session.entries, run.inputFingerprint?.branchLeaf);
    row.frozenLeafAvailable = true;
  } catch (error) { row.frozenLeafAvailable = false; row.historyError = String(error); }
  if (slot.rawOutput?.trim()) {
    const matched = slot.attempts.findLast(attempt => attempt.rawOutput === slot.rawOutput);
    row.savedResponseAccepted = !!matched && complete(matched);
    if (!matched) row.responseError = "Saved response has no matching persisted attempt; completion cannot be verified";
    if (row.savedResponseAccepted) {
      const body = validateOutput(slot.rawOutput).summary;
      if (typeof run.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run.operationId)) throw Error(`Invalid operation id in copied run ${name}: ${run.operationId}`);
      const bodyPath = join(output, `${run.operationId}.md`);
      if (existsSync(bodyPath) && (!lstatSync(bodyPath).isFile() || lstatSync(bodyPath).isSymbolicLink())) throw Error(`Expected offline regular output file: ${bodyPath}`);
      writeFileSync(bodyPath, body, { mode: 0o600 });
      row.renderedChars = body.length;
      if (branch) try {
        const firstKept = run.inputFingerprint.firstKeptEntryId;
        const window = Object.hasOwn(run.threshold ?? {}, "effectiveWindow") ? run.threshold.effectiveWindow : run.threshold?.contextWindow;
        if (!Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(run.threshold?.contextWindow) || window > run.threshold.contextWindow) throw Error(`Invalid recovery window: effective=${window}, model=${run.threshold?.contextWindow}`);
        if (typeof session.cwd !== "string" || !session.cwd) throw Error("Copied session header cwd is missing; file inventory cannot be reconstructed");
        const quotes = collectUserQuotations(branch, firstKept), quotationText = renderUserQuotations(quotes);
        const inventory = renderInventory(collectInventory(branch, firstKept, session.cwd));
        // Run logs retain identities and token counts, not owner bodies. Only a matching persisted
        // compaction can prove the actual appendix; skill refs are never a substitute for content.
        const committed = session.entries.find(e => e.type === "compaction" && e.details?.operationId === run.operationId && e.parentId === run.inputFingerprint.branchLeaf && e.firstKeptEntryId === firstKept && e.details?.handoff === body && e.details?.generator === "pi-session-compact");
        if (!committed) throw Error("Matching persisted custom compaction is missing; recovery owner content is unavailable");
        const prefix = body + quotationText + inventory;
        if (!committed.summary.startsWith(prefix)) throw Error("Persisted compaction does not match the saved handoff, quotations and cwd-based inventory");
        const appendix = committed.summary.slice(prefix.length), recovery = committed.details.recovery;
        if (!appendix.startsWith("\n\n## 压缩恢复内容\n\n") || recovery?.version !== 1 || !Array.isArray(recovery.items) || !recovery.items.some(item => item.owner === "pi-session-compact")) throw Error("Persisted recovery appendix or owner identities are missing");
        if (!includesRecovery(committed.details, "pi-session-compact", "pi-session-compact:recovery-v1")) throw Error("Persisted compact recovery customType is missing or invalid");
        if (run.inputFingerprint.skillRefs?.length && !includesRecovery(committed.details, "pi-skills", "pi-skills:compact-restored-v1")) throw Error("Persisted required skill recovery customType is missing or invalid; skill references alone are insufficient");
        // Only the fixed collectRecovery owner-section grammar delimits bodies, not arbitrary Markdown headings.
        const sections = [...appendix.matchAll(/^### pi-(?:session-compact|skills|todo|processes|subagents) \([^\n]+\)\n\n/gm)];
        for (const item of recovery.items) {
          const marker = `### ${item.owner} (${item.customType})\n\n`, at = sections.findIndex(section => section[0] === marker);
          if (at < 0) throw Error(`Persisted recovery content is missing for ${item.owner} (${item.customType})`);
          const content = appendix.slice(sections[at].index + marker.length, sections[at + 1]?.index ?? appendix.length);
          if (!content.trim()) throw Error(`Persisted recovery content is empty for ${item.owner} (${item.customType})`);
        }
        const systemMessage = committed.systemMessage;
        if (systemMessage?.role !== "system") throw Error("Persisted systemMessage is missing; system/tool content cannot be reconstructed from token counts");
        const estimate = run.contextSizes?.after?.estimated, additionalTokens = estimate?.otherInjected, reserveTokens = run.threshold.reserveTokens;
        if (!Number.isFinite(additionalTokens) || additionalTokens < 0) throw Error("Persisted requestOnlyTokens accounting (after.estimated.otherInjected) is missing or invalid");
        if (!Number.isFinite(reserveTokens) || reserveTokens < 0) throw Error("Persisted reserveTokens is missing or invalid");
        const bound = estimate?.providerUpperBound ?? run.contextSizes?.before?.recoveryBound;
        if (bound != null && !validRecoveryBound(bound)) throw Error("Persisted recovery bound is invalid");
        const result = { summary: prefix + appendix, firstKeptEntryId: firstKept, tokensBefore: committed.tokensBefore };
        const gate = restoredContext(branch, result, window, { systemMessage, additionalTokens, reserveTokens, bound: bound ?? undefined, recoveryAppendix: appendix, handoff: body, quotations: quotationText, inventory });
        row.originalCutWindow = { passed: gate.fits, completeRecoveryVerified: true, window, ...gate.estimated, userMessageCount: quotes.items.length };
      } catch (error) { row.recoveryError = `Cannot fully verify restored context: ${String(error)}`; }
    }
  }
  rows.push(row);
}
const summary = { realRequests: 0, samples: rows.length, firstResponseAccepted: rows.filter(r => r.firstResponseAccepted).length, savedResponseAccepted: rows.filter(r => r.savedResponseAccepted).length, unusableSavedResponses: rows.filter(r => !r.savedResponseAccepted).length, originalCutWindowPassed: rows.filter(r => r.originalCutWindow?.passed).length, originalCutWindowFailed: rows.filter(r => r.originalCutWindow && !r.originalCutWindow.passed).length, originalCutWindowUnverified: rows.filter(r => !r.originalCutWindow).length, rows };
const summaryPath = join(output, "summary.json");
if (existsSync(summaryPath) && (!lstatSync(summaryPath).isFile() || lstatSync(summaryPath).isSymbolicLink())) throw Error(`Expected offline regular output file: ${summaryPath}`);
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
