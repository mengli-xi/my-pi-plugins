import { installMailboxBindingStub } from "../fixtures/mailbox-binding-stub.ts";
installMailboxBindingStub();
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";

/**
 * 清理 pass 扫描的 base 必须在本文件加载时就固定到独立 temp 目录：
 * dist/index.js 的一次性 guard 会在第一次 session_start 触发，机器上真实的历史 root 不能被扫到。
 *
 * 隔离手段是标准 TMPDIR，不是 package 私有的环境变量：node --test 每个测试文件跑在自己的子进程里，
 * os.tmpdir() 每次调用都读 TMPDIR，因此 SupervisorClient 造 root 和清理 pass 扫描仍然指向同一个 base。
 */
const realTmpdir = tmpdir();
const scavengeBase = mkdtempSync(join(realTmpdir, "pi-processes-scavenge-integration-"));
process.env.TMPDIR = scavengeBase;
process.env.PI_CODING_AGENT_DIR = join(scavengeBase, "agent");
after(() => { rmSync(scavengeBase, { recursive: true, force: true }); });

interface FakeRuntime {
  handlers: Map<string, Array<(event: unknown, context: unknown) => unknown>>;
  notifications: string[];
  api: any;
}

function createRuntime(): FakeRuntime {
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  const eventHandlers = new Map<string, Array<(value: unknown) => void>>();
  const notifications: string[] = [];
  const api = {
    on(name: string, handler: (event: unknown, context: unknown) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    events: {
      on(name: string, handler: (value: unknown) => void) {
        const current = eventHandlers.get(name) ?? [];
        current.push(handler);
        eventHandlers.set(name, current);
        return () => { eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler)); };
      },
      emit(name: string, value: unknown) { for (const handler of eventHandlers.get(name) ?? []) handler(value); },
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry() {},
    sendMessage() {},
  };
  return { handlers, notifications, api };
}

function sessionContext(sessionId: string, runtime: FakeRuntime): any {
  return {
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: false,
    isProjectTrusted: () => false,
    isIdle: () => true,
    signal: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      getEntries: () => [],
      getLeafEntry: () => undefined,
    },
    ui: {
      notify: (message: string) => runtime.notifications.push(message),
      setWidget: () => {},
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
      getEditorText: () => "",
      setEditorText: () => {},
      custom: () => Promise.resolve(),
      theme: { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text },
    },
  };
}

async function emit(runtime: FakeRuntime, name: string, event: unknown, context: unknown): Promise<void> {
  for (const handler of runtime.handlers.get(name) ?? []) await handler(event, context);
}

async function plantRoot(piPid: number, supervisorPid: number): Promise<string> {
  const hostNonce = randomBytes(32).toString("hex");
  const path = join(scavengeBase, `pi-processes-${piPid}-${hostNonce}`);
  await mkdir(path, { mode: 0o700 });
  await mkdir(join(path, "records"), { mode: 0o700 });
  await writeFile(join(path, "supervisor.json"), JSON.stringify({ version: 1, hostNonce, piPid, supervisorPid, generation: 1 }), { mode: 0o600 });
  return path;
}

async function deadPid(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
    await new Promise((resolve) => setImmediate(resolve));
    if (!pid) continue;
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not obtain a confirmed dead pid");
}

async function livePid(t: TestContext): Promise<number> {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(child.pid, "helper child has a pid");
  return child.pid;
}

async function waitForRemoval(path: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path} to be removed`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("os.tmpdir() re-reads TMPDIR, so the compiled entry scans this file's isolated base", () => {
  assert.notEqual(scavengeBase, realTmpdir);
  assert.equal(tmpdir(), scavengeBase);
});

test("compiled extension scavenges abandoned private roots once per startup", async (t) => {
  const dead = await plantRoot(await deadPid(), await deadPid());
  const alive = await plantRoot(await livePid(t), await deadPid());
  const own = await plantRoot(process.pid, await deadPid());

  const extension = (await import(new URL("../../dist/index.js", import.meta.url).href)).default as (api: unknown) => void;
  const runtime = createRuntime();
  extension(runtime.api);
  const context = sessionContext(`integration-scavenge-${crypto.randomUUID()}`, runtime);

  await emit(runtime, "session_start", { reason: "startup" }, context);
  try {
    await waitForRemoval(dead);
    assert.equal(existsSync(alive), true, "a root whose Pi process is still alive is retained");
    assert.equal(existsSync(own), true, "the current Pi process never removes its own root");
  } finally {
    await emit(runtime, "session_shutdown", { reason: "quit" }, context);
  }
});
