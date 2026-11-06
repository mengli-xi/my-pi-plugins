import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cases = [
  ...["before-body:1", "after-body:1", "before-body:2", "after-body:2", "before-control", "after-control", "request-observed", "request-success", "before-delivery", "after-delivery", "before-terminal", "after-terminal", "after-recorded-source-ack", "after-recorded-ack", "after-terminal-source-ack", "after-terminal-ack"].map(point => ["normal", point]),
  ...["import-new", "import-pending"].flatMap(mode => ["legacy-intent", "before-delivery", "after-delivery", "before-terminal", "after-terminal"].map(point => [mode, point])),
  ...["normal", "cancel"].flatMap(mode => ["before-snapshot-unlink", "after-snapshot-unlink", "before-snapshot-rmdir", "after-snapshot-rmdir"].map(point => [mode, point])),
];
for (const [mode, point] of cases) test(`transport SIGKILL ${mode} at ${point} recovers actual carriers, receipt and stable ACK tokens`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-transport-kill-"));
  const run = (phase: string) => new Promise<any>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./transport-crash-child.ts", import.meta.url)), [directory, mode!, point!, phase], {
      execArgv: ["--import", fileURLToPath(new URL("./ts-resolve.mjs", import.meta.url)), "--experimental-strip-types"], silent: true, cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    let stderr = "", message: any; child.stderr!.on("data", data => { stderr += data; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timed out: ${stderr}`)); }, 15000);
    child.on("message", value => { message = value; if ((value as any).checkpoint) child.kill("SIGKILL"); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (phase === "crash" && signal === "SIGKILL" && message?.checkpoint === point || phase === "recover" && code === 0 && message?.recovered) resolve(message);
      else reject(new Error(`child ${phase} exited ${code}/${signal}: ${stderr}`));
    });
  });
  try {
    await run("crash");
    const meta = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
    const snapshot = JSON.parse(await readFile(join(directory, "agent", "mailbox", "v1", meta.sessionId, "pending.json"), "utf8")
      .catch(error => { if (error.code === "ENOENT") return '{"pending":[],"terminal":[]}'; throw error; }));
    const recordedToken = snapshot.pending[0]?.recorded?.notice.recordedToken ?? snapshot.terminal[0]?.recorded?.notice.recordedToken;
    const evidenceToken = snapshot.pending[0]?.legacyImport?.evidence.terminalId ?? snapshot.terminal[0]?.evidence.terminalId;
    const result = (await run("recover")).recovered;
    if (["after-delivery", "before-terminal", "after-terminal", "after-terminal-source-ack", "after-terminal-ack"].includes(point!) || point!.includes("snapshot-")) assert.equal(result.requests, 0);
    if (recordedToken) assert.deepEqual(result.recordedTokens, [recordedToken]);
    if (evidenceToken) assert.deepEqual(result.terminalTokens, [evidenceToken]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
