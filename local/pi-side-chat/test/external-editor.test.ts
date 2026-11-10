import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editInParentTerminal } from "../external-editor.ts";

// Readiness is host scheduling, not the behavior under test, so it gets a generous bound.
// The abort-to-close contract below keeps its own exact assertions.
const EDITOR_READY_TIMEOUT_MS = 20_000;
const EDITOR_CLOSE_TIMEOUT_MS = 10_000;
const EDITOR_SETTLE_TIMEOUT_MS = 10_000;
const EDITOR_REAP_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settle(promise: Promise<unknown>, ms: number): Promise<void> {
  await within(promise, ms, "settle timeout").catch(() => undefined);
}

function readEditorPid(pidFile: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function reapEditorProcess(pid: number): Promise<void> {
  if (!isRunning(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process disappeared between the liveness probe and the signal.
    }
  }
  const deadline = Date.now() + EDITOR_REAP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return;
    await delay(10);
  }
}

test("parent external editor round-trips Side draft text and removes the trailing newline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-editor-test-"));
  try {
    const editor = join(directory, "editor.sh");
    writeFileSync(editor, '#!/bin/sh\nprintf "edited by parent\\n" > "$1"\n', { mode: 0o700 });
    chmodSync(editor, 0o700);
    const result = await editInParentTerminal(editor, "original draft");
    assert.equal(result, "edited by parent");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parent external editor returns undefined on non-zero exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-editor-fail-"));
  try {
    const editor = join(directory, "editor.sh");
    writeFileSync(editor, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    chmodSync(editor, 0o700);
    assert.equal(await editInParentTerminal(editor, "draft"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aborting the parent editor waits for its real process close", async () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "side-editor-abort-"));
  const pidFile = join(directory, "pid");
  const controller = new AbortController();
  let editing: Promise<string | undefined> | undefined;
  let pid: number | undefined;
  try {
    const editor = join(directory, "editor.sh");
    // The pid lands through a rename so a visible pid file always holds a complete pid.
    writeFileSync(
      editor,
      `#!/bin/sh\ntrap '' TERM\necho $$ > ${JSON.stringify(`${pidFile}.tmp`)}\nmv ${JSON.stringify(`${pidFile}.tmp`)} ${JSON.stringify(pidFile)}\nwhile true; do sleep 1; done\n`,
      { mode: 0o700 },
    );
    chmodSync(editor, 0o700);
    editing = editInParentTerminal(editor, "draft", controller.signal, 50);
    let exited = false;
    let outcome: unknown;
    void editing.then(
      (value) => {
        exited = true;
        outcome = value;
      },
      (error) => {
        exited = true;
        outcome = error;
      },
    );
    const started = Date.now();
    const deadline = started + EDITOR_READY_TIMEOUT_MS;
    while (pid === undefined && Date.now() < deadline) {
      pid = readEditorPid(pidFile);
      if (pid !== undefined) break;
      assert.equal(
        exited,
        false,
        `the editor exited before publishing its pid: ${JSON.stringify(String(outcome))}`,
      );
      await delay(10);
    }
    if (pid === undefined) {
      assert.fail(
        `no editor pid after ${Date.now() - started}ms (pid file present: ${existsSync(pidFile)})`,
      );
    }
    const editorPid = pid;
    controller.abort();
    // A close that never arrives must fail here, so the cleanup below still runs.
    const result = await within(
      editing,
      EDITOR_CLOSE_TIMEOUT_MS,
      `the editor did not close within ${EDITOR_CLOSE_TIMEOUT_MS}ms of abort`,
    );
    assert.equal(result, undefined);
    assert.throws(() => process.kill(editorPid, 0), /ESRCH/u);
  } finally {
    controller.abort();
    if (editing) await settle(editing, EDITOR_SETTLE_TIMEOUT_MS);
    pid ??= readEditorPid(pidFile);
    if (pid !== undefined) await reapEditorProcess(pid);
    rmSync(directory, { recursive: true, force: true });
  }
});
