import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPiVersion, piBin } from "../../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
const root = dirname(fileURLToPath(import.meta.url));
const binary = piBin();
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), installedPiVersion());
const artifact = process.env.MAILBOX_FOLLOWUP_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "mailbox-followup-"));
mkdirSync(artifact, { recursive: true });
const sdkRoot = join(artifact, "sdk"); mkdirSync(sdkRoot, { recursive: true });
const sdk = execFileSync(process.execPath, ["--import", join(root, "../../../../ts-resolve.mjs"), "--experimental-strip-types", join(root, "sdk-followup.ts")], {
  cwd: sdkRoot,
  env: { PATH: process.env.PATH, HOME: sdkRoot, PI_CODING_AGENT_DIR: join(sdkRoot, "agent"), TMPDIR: sdkRoot, PI_OFFLINE: "1", PI_TELEMETRY: "0", MAILBOX_FOLLOWUP_ROOT: sdkRoot }, timeout: 30000, encoding: "utf8", maxBuffer: 2 ** 20,
});
writeFileSync(join(sdkRoot, "result.json"), sdk); const results = JSON.parse(sdk.trim()).results;
const entry = join(artifact, "entry.ts");
let imports = `import followup from ${JSON.stringify(join(root, "followup.ts"))};\n`;
if (process.env.MAILBOX_GOAL_BUNDLE) {
  // Copy only C's compiled artifact. All public dependencies resolve through this
  // stock host; no other worktree's node_modules is loaded or changed.
  for (const name of readdirSync(dirname(process.env.MAILBOX_GOAL_BUNDLE))) if (name.endsWith(".js")) copyFileSync(join(dirname(process.env.MAILBOX_GOAL_BUNDLE), name), join(artifact, name));
  copyFileSync(process.env.MAILBOX_GOAL_BUNDLE, join(artifact, "goal-compiled.js"));
  imports += 'import goal from "./goal-compiled.js";\nexport default pi => followup(pi, goal);\n';
} else imports += "export default followup;\n";
writeFileSync(entry, imports);
const bundle = join(artifact, "extension.js");
execFileSync("bun", ["build", entry, "--target=node", "--format=esm", "--packages=external", `--outfile=${bundle}`], { stdio: "pipe" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const scenario of [...(process.env.MAILBOX_GOAL_BUNDLE ? ["goal"] : []), "reopen", "fork-return", "proof-conflict", "natural", "late-writer"]) {
  const directory = join(artifact, scenario); for (const name of ["home", "agent", "cwd", "tmp"]) mkdirSync(join(directory, name), { recursive: true });
  const log = join(directory, "events.jsonl"); writeFileSync(log, "");
  writeFileSync(join(directory, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const child = spawn(binary, ["--mode", "rpc", "--offline", "--approve", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "-e", bundle, "--provider", "mailbox-faux", "--model", "fixture", "--thinking", "off"], {
    cwd: join(directory, "cwd"), env: { PATH: process.env.PATH, HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"), TMPDIR: join(directory, "tmp"), PI_OFFLINE: "1", PI_TELEMETRY: "0", MAILBOX_NATIVE_LOG: log, MAILBOX_FOLLOWUP_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", id = 0;
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const rows = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const send = message => child.stdin.write(JSON.stringify({ id: String(++id), type: "prompt", message }) + "\n");
  const until = async predicate => { const end = Date.now() + 20000; while (!predicate()) { if (Date.now() > end || child.exitCode !== null) throw Error(`timeout ${scenario}: ${stderr}\n${stdout.slice(-2500)}\n${JSON.stringify(rows().slice(-3))}`); await delay(20); } };
  const result = { scenario };
  try {
    if (scenario === "late-writer") {
      await until(() => rows().some(row => row.stage === "start"));
      const start = rows().find(row => row.stage === "start");
      const identity = { id: start.sessionId, file: start.file, cwd: join(directory, "cwd") };
      const pending = { producer: "pi-processes", key: "old-other-process", anchorEntryId: start.anchorEntryId, policy: "next-request", wake: true,
        messages: [{ customType: "proof-body", content: "OLD_OTHER_PROCESS", display: false }], acceptedRevision: 1,
        requiredCallbacks: { recorded: false, terminal: false }, branchEntryId: null, nativeEntries: [], recorded: null };
      const module = new URL("../../src/mailbox-v1/store.ts", import.meta.url).href;
      const code = `import {MailboxStore} from ${JSON.stringify(module)}; const [directory,identity,pending]=process.argv.slice(1); const store=new MailboxStore(directory,JSON.parse(identity)); await store.acquire(); await store.transact(draft=>{draft.pending.push(JSON.parse(pending));}); await store.close();`;
      execFileSync(process.execPath, ["--import", join(root, "../../../../ts-resolve.mjs"), "--experimental-strip-types", "--input-type=module", "-e", code, join(directory, "agent"), JSON.stringify(identity), JSON.stringify(pending)], {
        cwd: join(directory, "cwd"), env: { PATH: process.env.PATH, HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1" },
      });
      send("/mailtest-live-put");
    } else send(scenario === "goal" ? "/goal Complete isolated fresh process continuation regression" : "INITIAL");
    if (scenario === "goal") {
      await until(() => rows().some(row => row.stage === "settled" && row.calls >= 2 && row.goal?.goal === null));
      const final = rows().filter(row => row.stage === "settled").at(-1);
      assert.equal(final.bodies, 1); assert.equal(final.controls, 1); assert.equal(final.calls, 2);
    } else if (scenario === "reopen" || scenario === "fork-return") {
      await until(() => rows().some(row => row.stage === "settled"));
      if (scenario === "fork-return") {
        send("/mailtest-fork-seed"); await until(() => rows().some(row => row.stage === "recorded")); send("/mailtest-fork-return");
      } else send("/mailtest-return");
      await until(() => rows().some(row => row.stage === "returned"));
      send("/mailtest-target"); await until(() => rows().some(row => row.stage === "target"));
      const starts = rows().filter(row => row.stage === "start"); assert.equal(starts.length, 3); assert.equal(starts[0].sessionId, starts[2].sessionId);
      if (scenario === "fork-return") {
        const child = rows().find(row => row.stage === "fork-child"); assert.equal(child.bodies, 0);
        const snapshot = join(directory, "agent", "mailbox", "v1", child.sessionId, "pending.json");
        if (existsSync(snapshot)) assert.equal(JSON.parse(readFileSync(snapshot, "utf8")).pending.length, 0);
      }
      send("AFTER_REOPEN"); await until(() => rows().filter(row => row.stage === "request").length === 2 && rows().filter(row => row.stage === "settled").length === 2);
      if (scenario === "fork-return") { await until(() => rows().some(row => row.stage === "terminal")); assert.equal(rows().filter(row => row.stage === "settled").at(-1).bodies, 1); }
    } else if (scenario === "proof-conflict") {
      await until(() => rows().some(row => row.stage === "conflict-put")); await delay(250);
      assert.equal(rows().filter(row => row.stage === "request").length, 1, "conflicting proof cannot create an empty request");
      send("/mailbox resume"); await delay(250); assert.equal(rows().filter(row => row.stage === "request").length, 1);
      send("/mailtest-repair"); await until(() => rows().some(row => row.stage === "repaired")); send("/mailbox resume");
      await until(() => rows().some(row => row.stage === "terminal"));
      assert.equal(rows().filter(row => row.stage === "request").length, 2);
      assert.ok(JSON.stringify(rows().filter(row => row.stage === "request")[1]).includes("PROOF_BODY"));
    } else if (scenario === "late-writer") {
      await until(() => rows().some(row => row.stage === "terminal") && rows().some(row => row.stage === "settled"));
      const requests = rows().filter(row => row.stage === "request"); assert.equal(requests.length, 1);
      assert.ok(JSON.stringify(requests[0]).includes("NEW_THIS_PROCESS")); assert.ok(!JSON.stringify(requests[0]).includes("OLD_OTHER_PROCESS"));
      const start = rows().find(row => row.stage === "start"), path = join(directory, "agent", "mailbox", "v1", start.sessionId, "pending.json");
      const snapshot = JSON.parse(readFileSync(path, "utf8")); assert.deepEqual(snapshot.pending.map(record => record.key), ["old-other-process"]);
      send("/mailbox status"); await until(() => stdout.includes("recovery held"));
    } else {
      await until(() => rows().some(row => row.stage === "terminal") && rows().some(row => row.stage === "settled" && row.calls === 2)); await delay(250);
      assert.equal(rows().filter(row => row.stage === "request").length, 2);
      const final = rows().filter(row => row.stage === "settled").at(-1); assert.equal(final.bodies, 1); assert.equal(final.controls, 0);
      assert.ok(JSON.stringify(rows().filter(row => row.stage === "request")[1]).includes("NATURAL_BODY"));
    }
    assert.ok(!stdout.includes('"type":"extension_error"'), stdout); result.fauxRequests = rows().filter(row => row.stage === "request").length; result.passed = true;
  } catch (error) { result.passed = false; result.error = String(error); }
  child.stdin.end(); let timer;
  result.exit = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timeout: true }); }, 5000); })]); clearTimeout(timer);
  if (result.exit.code !== 0) result.passed = false;
  writeFileSync(join(directory, "rpc.jsonl"), stdout); writeFileSync(join(directory, "stderr.log"), stderr); results.push(result); console.log(JSON.stringify(result));
}
writeFileSync(join(artifact, "summary.json"), JSON.stringify({ version: installedPiVersion(), realRequests: 0, goalBundle: process.env.MAILBOX_GOAL_BUNDLE ?? null, results }, null, 2));
console.log(`Artifacts: ${artifact}`); process.exitCode = results.every(result => result.passed) ? 0 : 1;
