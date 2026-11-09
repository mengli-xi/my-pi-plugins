import assert from "node:assert/strict";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { freshHost, delay } from "../fixtures/fresh-host.ts";
const goal = resolve(import.meta.dirname, "../../../fork/pi-goal/extensions/pi-goal/dist/index.js");
for (const order of ["default", "reverse"] as const) for (const paused of [false, true]) test(`stock B/C/D ${order} with Goal ${paused ? "paused" : "active"}`, { timeout: 60_000 }, async t => {
  const prior = process.env.PI_MAILBOX_JOINT; process.env.PI_MAILBOX_JOINT = "1";
  t.after(() => { if (prior === undefined) delete process.env.PI_MAILBOX_JOINT; else process.env.PI_MAILBOX_JOINT = prior; });
  const h = await freshHost(t, "unused", false, 1, [goal], order);
  await h.rpc("prompt", { message: "FOREGROUND_CHECK" });
  await h.until(async () => (await h.rpc("get_entries")).entries as any[], entries => entries.some(entry => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("FOREGROUND_OK")), "initial accepted user run", 5_000);
  await h.rpc("prompt", { message: "/goal JOINT_GOAL: read and record the child and Process results, then complete." });
  await h.until(async () => {
    const entries: any[] = (await h.rpc("get_entries")).entries;
    try { await access(join(h.root, "joint-child-ready")); await access(join(h.root, "joint-process-ready")); }
    catch { return false; }
    return entries.some(entry => entry.type === "message" && entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("JOINT_WAITING"));
  }, Boolean, "both producers started", 12_000);
  await h.until(() => h.rpc("get_state"), state => state.isStreaming === false, "initial Goal run settled", 5_000);
  if (paused) await h.rpc("prompt", { message: "/goal pause" });
  await writeFile(join(h.root, "joint-release"), "release");
  // C defers admission while Main is busy; let it accept before D can start Main.
  let snapshotVersion = "";
  await h.until(async () => {
    try {
      const path = join(h.agentDir, "mailbox/v1", h.sessionId, "pending.json");
      const info = await stat(path, { bigint: true });
      const version = `${info.ino}:${info.size}:${info.mtimeNs}`;
      if (version === snapshotVersion) return false;
      const state = JSON.parse(await readFile(path, "utf8")); snapshotVersion = version;
      return state.pending.some((mail: any) => mail.producer === "pi-processes");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }, Boolean, "Process durably accepted before child release");
  await writeFile(join(h.root, "joint-child-release"), "release");
  const entries = await h.until(async () => (await h.rpc("get_entries")).entries as any[],
    entries => paused
      ? entries.some(entry => entry.type === "message" && entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("JOINT_RECORDED"))
      : entries.some(entry => entry.type === "custom" && entry.customType === "goal-state" && entry.data?.goal?.status === "complete"),
    "joint result", 20_000).catch(async error => { throw new Error(String(error).slice(-300) + "\n" + await readFile(join(h.root, "joint-decisions.jsonl"), "utf8")); });
  const state = entries.filter(entry => entry.type === "custom" && entry.customType === "goal-state" && entry.data?.goal?.status === (paused ? "paused" : "complete")).at(-1)?.data;
  assert.ok(!h.records.some((row:any)=>row.type==="extension_error"),"fixture lifecycle errors cannot be swallowed as a passing result");
  assert.equal(state.goal.status, paused ? "paused" : "complete");
  const cards = entries.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-completion-v1");
  const batches = entries.filter(entry => entry.type === "custom_message" && entry.customType === "process-notification-batch-v1");
  assert.equal(cards.length, 1); assert.equal(batches.length, 1);
  const controls = entries.filter(entry => entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1");
  assert.equal(new Set(controls.map(entry => entry.details.attemptId)).size, controls.length);
  const calls = (await readFile(join(h.root, "provider.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const main = calls.filter(call => call.sessionId === h.sessionId).length, child = calls.length - main;
  assert.equal(child, 1);
  const snapshot = await h.snapshot();
  assert.equal(snapshot.snapshot.agents[0].tasks[0].phase, "settled");
  const fallback = entries.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1").length;
  if(paused)assert.ok(fallback===0||fallback===1,"paused Goal may legally suppress or use one producer fallback");else assert.equal(fallback,0);
  assert.equal(main, process.env.PI_MAILBOX_FULL_PROFILE === "1" ? 5 : 4, "one same-cutoff result request, naming budget separate");
  assert.equal(controls.length, 1);
  const cutoff = JSON.parse(await readFile(join(h.root, "joint-cutoff.json"), "utf8"));
  assert.equal(cutoff.firstAttemptIncludesBoth, true);
  assert.equal(cutoff.admitted.length,2);
  const receiptRows=await h.until(async()=> (await h.rpc("get_entries")).entries as any[],rows=>cutoff.admitted.every((admitted:any)=>rows.filter(e=>e.type==="custom"&&e.customType==="agent-mailbox-delivery-v1").flatMap(e=>e.data.terminals).some(t=>t.mail.producer===admitted.producer&&t.mail.key===admitted.key&&t.evidence.outcome==="fulfilled")),"both result receipts committed");
  const fulfilled=receiptRows.filter(e=>e.type==="custom"&&e.customType==="agent-mailbox-delivery-v1").flatMap(e=>e.data.terminals).filter(t=>t.evidence.outcome==="fulfilled");
  const counts=new Map<string,number>();for(const terminal of fulfilled){const key=JSON.stringify([terminal.mail.producer,terminal.mail.key]);counts.set(key,(counts.get(key)??0)+1);}assert.ok([...counts.values()].every(n=>n===1),"each key is fulfilled at most once");
  for(const admitted of cutoff.admitted)assert.equal(counts.get(JSON.stringify([admitted.producer,admitted.key])),1,"both same-cutoff result keys are fulfilled exactly once");
  const handling = calls.filter(call => call.sessionId === h.sessionId && !call.messages.some((m: any) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("You name coding sessions for a session picker.")))[cutoff.businessRequestsBefore];
  const firstHandling = JSON.stringify(handling.messages);
  assert.ok(firstHandling.includes("<subagent_completion") && firstHandling.includes("JOINT_CHILD_DONE"));
  assert.ok(firstHandling.includes("Process 'joint_process' succeeded"), "first handling context must contain both real source results");
  t.diagnostic(JSON.stringify({ order, paused, mainProviderRequests: main, childProviderRequests: child, controls: controls.length, cards: cards.length, batches: batches.length, fallback, firstAttemptIncludesBoth: cutoff.firstAttemptIncludesBoth, firstHandlingIncludesBoth: true, iteration: state.goal.iteration }));
  await delay(100);
  const finalCalls = (await readFile(join(h.root, "provider.jsonl"), "utf8")).trim().split("\n").length;
  assert.equal(finalCalls, calls.length, "settled sources must not add another provider request");
  await h.stop();
});
