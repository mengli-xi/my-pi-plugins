import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { freshHost, delay } from "../fixtures/fresh-host.ts";

for (const mode of ["native", "extension", "failed", "cancel", "active-native"]) {
  test(`completion during manual ${mode} compaction drains without another prompt`, { timeout: 40000 }, async t => {
    const host = await freshHost(t, "COMPACT_REINJECT_CHILD", false, 1, [resolve(import.meta.dirname, "../../../local/pi-subagents/test/fixtures/compact-reinject.ts")]);
    await host.rpc("prompt", { message: "SEED " + "z".repeat(100000) });
    await host.until(() => host.records.filter(row => row.type === "agent_end").length, n => n >= 1, "seed finished");
    await host.rpc("prompt", { message: "REINJECT_SETUP " + "z".repeat(100000) });
    await host.until(() => host.records.filter(row => row.type === "agent_end").length, n => n >= 2, "setup finished");
    const compact = host.rpc(mode === "active-native" ? "prompt" : "compact", mode === "active-native" ? { message: "REINJECT_ACTIVE" } : {}).catch(error => ({ error: String(error) }));
    await host.until(() => existsSync(join(host.root, "compact-entered")), Boolean, "compaction entered");
    await writeFile(join(host.root, "child-release"), "yes");
    // Both producers must have actually completed while compaction is blocked.
    await host.until(async () => JSON.stringify(await host.snapshot()), text => text.includes('"phase":"settled"'), "child completed during compaction");
    await host.until(async () => (await host.rpc("get_entries")).entries as any[], entries => entries.some(row => row.customType === "process-event-v2" && JSON.stringify(row.data).includes('"terminal"')), "process completed during compaction");
    await writeFile(join(host.root, "compact-release"), mode);
    const result = await compact;
    if (mode === "failed" || mode === "cancel") assert.ok(result.error, JSON.stringify(result));
    const entries = await host.until(async () => (await host.rpc("get_entries")).entries as any[], entries =>
      entries.some(row => row.customType === "subagent-completion-v1") && entries.some(row => row.customType === "process-notification-batch-v1"), "both completions delivered", 4000);
    for (const type of ["subagent-completion-v1", "process-notification-batch-v1"]) {
      assert.equal(entries.filter(row => row.customType === type).length, 1, type);
      if (mode === "native" || mode === "extension" || mode === "active-native") assert.ok(entries.findIndex(row => row.customType === type) > entries.findIndex(row => row.type === "compaction"), type);
    }
    for (const type of ["subagent-compact-state-v1", "process-compact-state-v1"]) assert.equal(entries.filter(row => row.customType === type).length, 0, "completed work is not reinjected as live");
    await host.until(async () => readFile(join(host.root, "compact-requests.jsonl"), "utf8"), log => log.includes("CHILD_COMPACT_DONE"), "completion reaches the provider");
    assert.equal(host.stderr.includes("native entry proof failed"), false, host.stderr);
    await host.stop();
  });
}

for (const active of [false, true]) {
  test(`live snapshots follow compaction with Main ${active ? "active" : "idle"} and never start another run`, { timeout: 40000 }, async t => {
    const host = await freshHost(t, "COMPACT_REINJECT_CHILD", false, 1, [resolve(import.meta.dirname, "../../../local/pi-subagents/test/fixtures/compact-reinject.ts")]);
    await host.rpc("prompt", { message: "SEED " + "z".repeat(100000) });
    await host.until(() => host.records.filter(row => row.type === "agent_settled").length, n => n >= 1, "seed settled");
    await host.rpc("prompt", { message: "REINJECT_SETUP " + "z".repeat(100000) });
    await host.until(() => host.records.filter(row => row.type === "agent_settled").length, n => n >= 2, "setup settled");
    const action = active ? host.rpc("prompt", { message: "REINJECT_ACTIVE" }) : host.rpc("compact");
    await host.until(() => existsSync(join(host.root, "compact-entered")), Boolean, "compaction entered");
    await writeFile(join(host.root, "compact-release"), active ? "native" : "extension");
    await action;
    const entries = await host.until(async () => (await host.rpc("get_entries")).entries as any[], entries => {
      const id = entries.filter(row => row.type === "compaction").at(-1)?.id;
      return id && ["subagent-compact-state-v1", "process-compact-state-v1"].every(type => entries.some(row => row.customType === type && row.details?.compactionId === id));
    }, "both live snapshots appended")
      .catch(async () => { const state = await host.snapshot(); throw new Error(JSON.stringify({ operation: "live-compaction-snapshots", diagnostics: state.diagnostics,
        agents: state.snapshot?.agents.map((item: any) => ({ taskName: item.agent.task_name, tasks: item.tasks.map((task: any) => ({ phase: task.phase, reason: task.reason, outcome: task.outcome })), completions: item.completions })) })); });
    const compactIndex = entries.map((row, index) => row.type === "compaction" ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
    const compactionId = entries[compactIndex]?.id;
    const messages = ["subagent-compact-state-v1", "process-compact-state-v1"].map(type => {
      const snapshots = entries.filter(row => row.customType === type);
      assert.equal(new Set(snapshots.map(row => row.details.compactionId)).size, snapshots.length, type);
      assert.equal(snapshots.filter(row => row.details.compactionId === compactionId).length, 1, type);
      const index = entries.findIndex(row => row.customType === type && row.details.compactionId === compactionId);
      assert.ok(index > compactIndex, type);
      assert.equal(entries[index].display, false);
      return entries[index];
    });
    assert.match(messages[0].content, /compact_child.*Task tsk_.*状态：(?:running|starting|admitted)/);
    assert.match(messages[1].content, /proc_.*compact_process.*状态：running.*while.*pi-processes-.*records/);
    const starts = active ? 3 : 2;
    await host.until(() => host.records.filter(row => row.type === "agent_settled").length, n => n >= starts, "Main settled");
    await delay(100);
    assert.equal(host.records.filter(row => row.type === "agent_start").length, starts, "snapshot did not start a run");
    await host.rpc("prompt", { message: "CHECK_LIVE_CONTEXT" });
    await host.until(() => host.records.filter(row => row.type === "agent_settled").length, n => n >= starts + 1, "context check settled");
    const requests = (await readFile(join(host.root, "compact-requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(requests.some(row => JSON.stringify(row.messages).includes("仍未完成的子任务") && JSON.stringify(row.messages).includes("仍在运行的后台进程")), "both hidden snapshots reach provider context");
    // An ordinary request may cause another real compaction. Each ID still gets
    // one snapshot; reload/session restoration must not add another of its own.
    const beforeReload = (await host.rpc("get_entries")).entries as any[];
    const types = ["subagent-compact-state-v1", "process-compact-state-v1"];
    for (const type of types) {
      const snapshots = beforeReload.filter(row => row.customType === type);
      assert.equal(new Set(snapshots.map(row => row.details.compactionId)).size, snapshots.length, type);
    }
    await host.control("reload");
    const restored = (await host.rpc("get_entries")).entries as any[];
    for (const type of types) assert.equal(restored.filter(row => row.customType === type).length, beforeReload.filter(row => row.customType === type).length, type);
    await host.stop();
  });
}
