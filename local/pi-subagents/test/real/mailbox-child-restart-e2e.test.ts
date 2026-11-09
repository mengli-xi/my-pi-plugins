import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { freshHost, delay } from "../fixtures/fresh-host.js";

function handledByMain(outbox: any, sessionId: string): boolean {
  return outbox?.state === "handled" && outbox.wake_state === "settled"
    && outbox.handling_proof?.session_id === sessionId
    && outbox.completion_ids.every((id: string) => outbox.handling_proof.cards.some((card: any) => card.completion_id === id && card.assistant_entry_id));
}

test("host-lost child input is cancelled before the new Task request without releasing cold recovery", { timeout: 60_000 }, async t => {
  const previous = process.env.PI_SDK_RELOAD_TEST; process.env.PI_SDK_RELOAD_TEST = "1";
  t.after(() => { if (previous === undefined) delete process.env.PI_SDK_RELOAD_TEST; else process.env.PI_SDK_RELOAD_TEST = previous; });
  const h = await freshHost(t, "SDK_RELOAD_SUBJECT");
  let second: Awaited<ReturnType<typeof reopen>> | undefined;
  try {
    await h.rpc("set_session_name",{name:"SDK child restart contract"});
    await h.rpc("prompt", { message: "/subagents-test-spawn" });
    const initial = await h.until(h.snapshot, s => s.snapshot?.agents[0]?.tasks[0]?.phase === "waiting"
      && s.residents[0]?.residency?.state === "waiting" && s.residents[0]?.idle === true, "original Task parked");
    await h.until(async () => { try { return await readFile(join(h.root, "sdk-business.log"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
    }, log => log.split("\n").filter(line => line === "start").length === 1, "original shell running before host loss");
    const subject = initial.snapshot.agents[0], id = subject.agent.agent_id, childId = subject.agent.conversation.session_id;
    const childFile = join(initial.mainRoot, subject.agent.conversation.relative_path), pendingFile = join(h.agentDir, "mailbox/v1", childId, "pending.json");
    const mailbox = async (): Promise<any> => { try { return JSON.parse(await readFile(pendingFile, "utf8")); } catch(error) { if((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], terminal: [] }; throw error; } };
    const calls = async (): Promise<any[]> => (await readFile(join(h.root, "provider.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const entries = async (): Promise<any[]> => (await readFile(childFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    await writeFile(join(h.root, "sdk-gate-arm"), "input");
    await h.control("send_input", { target: id, message: "RELOAD_GATE_INPUT" });
    const checkpoint = await h.until<any>(async () => { try { return JSON.parse(await readFile(join(h.root, "sdk-checkpoint.json"), "utf8")); } catch (e) { if ((e as any).code === "ENOENT") return undefined; throw e; } }, Boolean, "native input before provider");
    const frozen = (await mailbox()).pending.find((m: any) => m.producer === "pi-subagents" && m.messages.some((v: any) => v.content === "RELOAD_GATE_INPUT"));
    assert.ok(frozen?.nativeEntries.some((p: any) => p.entryId === checkpoint.nativeEntryId));
    const atCapture = (await calls()).length; assert.equal(atCapture, 2);
    const exited = once(h.main, "exit"); h.main.kill("SIGKILL"); await exited;
    // End only the original shell; recovery must never start it again.
    await writeFile(join(h.root, "sdk-process-release"), "release");
    await writeFile(join(h.root, "sdk-gate-release"), "release");
    second = await reopen();
    const cold = await second.control("snapshot");
    assert.equal(cold.snapshot.agents[0].tasks[0].reason, "host-lost");
    assert.equal(cold.snapshot.agents[0].agent.lifecycle, "closed");
    assert.equal((await calls()).length, atCapture, "cold attach has zero requests");
    assert.ok((await mailbox()).pending.some((m: any) => m.key === frozen.key), "cold hold preserves the old record before a ready child exists");
    await second.rpc("prompt", { message: "FOREGROUND_CHECK" });
    await second.until(async () => second!.control("snapshot"), s => handledByMain(s.snapshot.agents[0].outbox[0], h.sessionId), "host-lost card handled by Main");
    const beforeResume = (await calls()).length;
    assert.equal((await second.control("resume_agent", { target: id })).details.outcome, "ok");
    assert.equal((await calls()).length, beforeResume, "resume is idle");
    assert.equal((await second.control("send_input", { target: id, message: "FOLLOWUP_SECOND" })).details.outcome, "ok");
    const final = await second.until(async () => second!.control("snapshot"), s => s.snapshot.agents[0].tasks[1]?.phase === "settled"
      && s.snapshot.agents[0].outbox.every((o: any) => handledByMain(o, h.sessionId)
        || (o.state === "delivered" && o.wake_state === "settled" && o.settlement_kind === "producer-fallback"
          && o.turn_settlement?.state === "settled" && o.settlement_proof_id)), "new generation completed");
    const current = final.snapshot.agents[0]; assert.equal(current.tasks.length, 2); assert.equal(current.completions.length, 2);
    assert.equal(current.tasks[1].outcome, "completed"); assert.ok(current.tasks[1].runtime_generation > subject.tasks[0].runtime_generation);
    const rows = await entries(), persisted = await mailbox();
    assert.equal(persisted.pending.some((m: any) => m.key === frozen.key), false);
    const receipts = rows.filter(e => e.customType === "agent-mailbox-delivery-v1").flatMap(e => e.data.terminals).filter(v => v.mail.key === frozen.key);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].evidence.outcome, "cancelled");
    assert.equal(rows.filter(e => e.type === "custom_message" && e.customType === "subagent-mailbox-v1" && e.content === "RELOAD_GATE_INPUT").length, 1);
    const sent = await calls(), childCalls = sent.filter(c => c.sessionId === childId), mainCalls = sent.filter(c => c.sessionId === h.sessionId);
    if (process.env.PI_CHILD_RESTART_EVIDENCE) {
      const directory = process.env.PI_CHILD_RESTART_EVIDENCE; await mkdir(directory, { recursive: true });
      await Promise.all([writeFile(join(directory, "provider.json"), JSON.stringify(sent)), writeFile(join(directory, "child.json"), JSON.stringify(rows)),
        writeFile(join(directory, "snapshot.json"), JSON.stringify(final)), writeFile(join(directory, "mailbox.json"), JSON.stringify(persisted))]);
    }
    assert.equal(childCalls.length, 3); assert.equal(mainCalls.length, 2);
    assert.equal(childCalls.slice(2).some(c => JSON.stringify(c.messages).includes("RELOAD_GATE_INPUT")), false);
    assert.equal(mainCalls.some(c => JSON.stringify(c.messages).includes("RELOAD_GATE_INPUT")), false);
    assert.equal((await readFile(join(h.root, "sdk-business.log"), "utf8")).split("\n").filter(l => l === "start").length, 1);
    t.diagnostic(JSON.stringify({ key: frozen.key, terminal: "cancelled", coldRequests: 0, childRequests: 3, mainRequests: 2, tasks: 2, completions: 2 }));
  } finally {
    await writeFile(join(h.root, "sdk-gate-release"), "release"); await writeFile(join(h.root, "sdk-process-release"), "release");
    if (second) await second.stop();
  }

  async function reopen() {
    const runtimeTmp=process.env.PI_MAILBOX_FULL_PROFILE==="1"?JSON.parse(await readFile(join(h.root,"profile-metadata.json"),"utf8")).runtimeTmp:undefined;
    const child = spawn(h.main.spawnfile, h.main.spawnargs.slice(1), { cwd: h.root, env: { ...process.env, HOME: h.root,
      ...(runtimeTmp?{TMPDIR:runtimeTmp}:{}),XDG_CONFIG_HOME:join(h.root,".config"),XDG_DATA_HOME:join(h.root,".local/share"),MAGIC_CONTEXT_STORAGE_DIR:join(h.root,"mc"),PI_SCHEDULER_BINARY:h.main.spawnfile,
      PI_CODING_AGENT_DIR: h.agentDir, PI_NEXT_AGENT_DIR: h.agentDir, PI_OFFLINE: "1", PI_SUBAGENTS_TEST_ASYNC: "1",
      PI_SUBAGENTS_TEST_MESSAGE: "SDK_RELOAD_SUBJECT", PI_SUBAGENTS_HOST_CONTROL: h.root, PI_SUBAGENTS_TEST_LOG: join(h.root, "provider.jsonl") }, stdio: ["pipe", "pipe", "pipe"] });
    const records: any[] = []; let buffer = "", stderr = "", serial = 0;
    child.stdout.on("data", data => { buffer += data; for (let at; (at = buffer.indexOf("\n")) >= 0;) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) records.push(JSON.parse(line)); } });
    child.stderr.on("data", data => { stderr += data; });
    const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    const until = async <T>(get: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> => {
      const deadline = Date.now() + 25_000;
      for (;;) { const value = await get(); if (accept(value)) return value; assert.ok(Date.now() < deadline && child.exitCode === null && child.signalCode === null, label + ": " + stderr + "\n" + JSON.stringify(value)); await delay(20); }
    };
    const rpc = async (type: string, data: any = {}) => {
      const id = `reopen-${++serial}`; child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
      const reply = await until<any>(async () => records.find(r => r.id === id), Boolean, id); assert.equal(reply.success, true, JSON.stringify(reply)); return reply.data;
    };
    const control = async (op: string, params?: any) => {
      const id = ++serial; await writeFile(join(h.root, "command.json"), JSON.stringify({ id, op, params }));
      await rpc("prompt", { message: "/subagents-host-control" });
      const value = JSON.parse(await readFile(join(h.root, "result.json"), "utf8")); assert.equal(value.id, id); return value.result;
    };
    try { await rpc("get_state"); } catch (error) { child.kill("SIGKILL"); await exit; throw error; }
    return { rpc, control, until, async stop() { child.stdin.end(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { assert.deepEqual(await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("reopened Pi did not exit: " + stderr)), 15_000); })]), { code: 0, signal: null }); }
      finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } }
    } };
  }
});
