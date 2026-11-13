import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

/** Real keys only; host hooks observe completion, never choose or perform an operation. */
export async function interact({ terminal, send, wait, events, delay, repetitions, users, rewind, navigationOnly = false, resetTarget, record }) {
  const operation = (method, after) => wait(e => e.type === "operation-complete" && e.method === method, after);
  const commandDone = (args, after) => wait(e => e.type === "command-complete" && e.command === "rewind" && e.args === args, after);
  async function editable(after) {
    terminal.write("BENCH_EDITABLE");
    const ready = await wait("editable", after);
    assert.equal(ready.accepted, true, "探针必须真的进入编辑器，不能留在 selector 或被吞掉");
    return ready;
  }
  async function fresh() {
    let after = events.length;
    terminal.write("\x15");
    send("/new");
    await wait("switch-complete", after);
    resetTarget();
    after = events.length;
    send("/resume");
    await wait("selector-ready", after);
    terminal.write("BENCH_SWITCH_TARGET");
    await delay(40);
    terminal.write("\r");
    await wait("switch-complete", after);
    const markerAfter = events.length;
    const ready = await editable(markerAfter);
    assert.equal(ready.branchUsers, users);
    terminal.write("\x15");
    await delay(40);
  }
  const targetRound = Math.min(200, users);
  const target = `BENCH_ROUND_${targetRound}`;
  async function arm(enters) {
    const after = events.length;
    send(`/bench-arm ${enters}`);
    await wait("armed", after);
  }
  async function pick(kind, repeat) {
    await arm(kind === "double-escape" ? 1 : 2);
    const after = events.length;
    const plugin = rewind && kind !== "tree";
    const opening = performance.now();
    if (kind === "double-escape") {
      terminal.write("\x1b");
      // 忙帧期间盲发两个 ESC 会被 PTY 合并成一个 Alt-Esc 输入。
      // 等首键实际交给编辑器，再立即发送第二键，仍走真实双击路径。
      await wait("escape-key", after);
      terminal.write("\x1b");
    } else send(kind === "tree" ? "/tree" : "/rewind");
    await wait(plugin ? "panel-ready" : "tree-ready", after);
    const chooserMs = performance.now() - opening;
    terminal.write(target);
    await delay(40);
    const selectedAfter = events.length;
    const start = performance.now();
    terminal.write("\r");
    const navigation = await operation("navigateTree", selectedAfter);
    const ready = await editable(selectedAfter);
    const elapsedMs = performance.now() - start;
    assert.equal(ready.branchUsers, targetRound - 1, "必须回到较早用户消息之前");
    record({ command: kind, route: plugin ? "rewind" : "tree", repeat, elapsedMs, chooserMs, navigation, ready });
    if (plugin) await commandDone("", after); // 归档可晚于可输入；不混入选择→可输入时间。
    terminal.write("\x15");
  }
  for (let repeat = 0; repeat < repetitions; repeat++) {
    let after;
    if (!navigationOnly) {
      await fresh();
      after = events.length;
      send("BENCH_ABORT");
      await wait("abort-active", after);
      // 至少等一帧，保证是已有正文的运行中中断，不是 Rewind 的连接中回退。
      await delay(40);
      after = events.length;
      const start = performance.now();
      terminal.write("\x1b");
      const idle = await wait("abort-idle", after);
      assert.equal(idle.aborted, true);
      const ready = await editable(after);
      record({ command: "escape", repeat, elapsedMs: performance.now() - start, ready });
    }

    await fresh();
    await pick("double-escape", repeat);
    if (!rewind) continue;
    if (!navigationOnly) {
      await fresh();
      await pick("tree", repeat); // Rewind 接管双 Esc 时，另量原生非破坏性导航。
    }

    // 显式入口及两种恢复入口都用真实 UI/命令，不调用插件内部函数。
    await fresh();
    await pick("rewind", repeat);
    if (navigationOnly) continue;
    await arm(2);
    after = events.length;
    const historyStart = performance.now();
    send("/rewind history");
    await wait("panel-ready", after);
    const chooserMs = performance.now() - historyStart;
    const restoreStart = performance.now();
    terminal.write("\r");
    await commandDone("history", after);
    const restored = await editable(after);
    assert.equal(restored.branchUsers, users);
    record({ command: "rewind-history", repeat, chooserMs, elapsedMs: performance.now() - restoreStart, ready: restored });
    terminal.write("\x15");

    await fresh();
    await pick("rewind-before-undo", repeat);
    await arm(1);
    after = events.length;
    const undoStart = performance.now();
    send("/rewind undo");
    await commandDone("undo", after);
    const undone = await editable(after);
    assert.equal(undone.branchUsers, users);
    record({ command: "rewind-undo", repeat, elapsedMs: performance.now() - undoStart, ready: undone });
    terminal.write("\x15");
  }
}
