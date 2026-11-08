import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { MailboxSnapshot } from "pi-session-inject/mailbox-v1/light";

for (const point of ["source-ack", "handled", "import-terminal", "cancel-terminal"]) test(`Main ACK/handled SIGKILL at ${point} recovers real source journal and Mailbox with original identities`, { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-source-kill-"));
  const run = (phase: string) => new Promise<any>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("../fixtures/mailbox-ack-crash.ts", import.meta.url)), [directory, point, phase], {
      execArgv: ["--import", fileURLToPath(new URL("../ts-resolve.mjs", import.meta.url)), "--experimental-strip-types"], silent: true,
      env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    let stderr = "", message: any; child.stderr!.on("data", data => { stderr += data; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timed out: ${stderr}`)); }, 20000);
    child.on("message", value => { message = value; if ((value as any).checkpoint) child.kill("SIGKILL"); });
    child.on("error", reject);
    child.on("exit", (code, signal) => { clearTimeout(timer);
      if (phase === "crash" && signal === "SIGKILL" && message?.checkpoint === point || phase === "recover" && code === 0 && message?.recovered) resolve(message);
      else reject(new Error(`child ${phase} exited ${code}/${signal}: ${stderr}`));
    });
  });
  try {
    await run("crash");
    const meta = JSON.parse(await readFile(join(directory, "main-meta.json"), "utf8"));
    const snapshot: MailboxSnapshot = JSON.parse(await readFile(join(directory, "agent/mailbox/v1", meta.sessionId, "pending.json"), "utf8"));
    const tokens = [...snapshot.pending, ...snapshot.terminal].flatMap(record => record.recorded?.ack === "pending" ? [record.recorded.notice.recordedToken] : []);
    const priorTerminals = snapshot.terminal.map(record => ({ key: record.mail.key, terminalId: record.evidence.terminalId, outcome: record.evidence.outcome }));
    const result = (await run("recover")).recovered;
    assert.equal(result.outboxId, meta.outboxId); assert.equal(result.epoch, point === "source-ack" ? 0 : 1);
    assert.equal(result.sends, 0); assert.equal(result.offers, 0); assert.equal(result.nativeContinuations, 0);
    for (const token of tokens) assert.ok(result.recordedTokens.includes(token), "the exact recordedToken survives source commit / A ACK loss");
    for (const terminal of priorTerminals) assert.deepEqual(result.terminals.find((item: { key: string }) => item.key === terminal.key), terminal, "first terminalId is immutable across recovery");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
