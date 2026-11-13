/** E-side stock-Pi check. A1 full transport recovery remains a separate gate. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fulfilledFinalAckLostFixture } from "../tests/fixtures/fulfilled-final-ack-lost.ts";
import { ping } from "../src/client.ts";
import { installedPiVersion } from "../../../scripts/pi-checks.mjs";
import { schedulerPaths } from "../src/paths.ts";
import { SchedulerStore } from "../src/store.ts";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.PI_BIN;
if (!binary) throw new Error("PI_BIN is required; use npm run check:host");
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "scheduler-stock-host-"));
const home = join(root, "home");
const agent = join(root, "agent");
const cwd = join(root, "cwd");
for (const d of [home, agent, cwd]) mkdirSync(d, { recursive: true });
const f = fulfilledFinalAckLostFixture(join(root, "session.jsonl"), cwd);
writeFileSync(f.snapshot.session.file, f.sessionEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }));
const paths = schedulerPaths(agent);
const store = new SchedulerStore(paths.root);
store.putInjection({ injectionId: f.injectionId, taskId: f.taskId, title: "Shared ACK recovery fixture", prompt: f.prompt,
  scheduledTime: f.scheduledTime, staleAt: f.scheduledTime + 1, createdAt: f.scheduledTime,
  sessionId: f.snapshot.session.id, phase: f.sourceMarkerPhase,
  mailbox: { anchorEntryId: f.mail.anchorEntryId, recordedToken: "recorded-injection-fixture", entryId: "native-injection-fixture" } });
const extension = join(root, "source-check.ts");
const resultPath = join(root, "result.json");
const moduleUrl = (p) => pathToFileURL(join(pkg, p)).href;
writeFileSync(extension, `import { writeFileSync } from "node:fs";
import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
import { schedulerProducer } from ${JSON.stringify(moduleUrl("src/mailbox-adapter.ts"))};
import { request } from ${JSON.stringify(moduleUrl("src/client.ts"))};
export default function(pi) {
 const faux=fauxProvider({provider:"scheduler-faux",api:"scheduler-faux",models:[{id:"source",contextWindow:200000,maxTokens:4096}]});
 pi.registerProvider(faux.provider);
 pi.on("session_start", async (_event,ctx) => {
  const source=schedulerProducer(body=>request(body,{socketPath:${JSON.stringify(paths.socket)}}));
  const evidence=${JSON.stringify(f.evidence)};
  const fence={slotKey:JSON.stringify([${JSON.stringify(agent)},ctx.sessionManager.getSessionId()]),session:{id:ctx.sessionManager.getSessionId(),file:ctx.sessionManager.getSessionFile()},bindingGeneration:1,ownerEpoch:1,producerToken:Symbol(),attemptId:null};
  await source.onTerminal(evidence,fence);
  await source.onTerminal(evidence,{...fence,ownerEpoch:2});
  writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({providerCalls:faux.state.callCount,terminalId:evidence.terminalId,sessionId:fence.session.id}));
  ctx.shutdown();
 });
}
`);
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0",
  PI_SCHEDULER_BINARY: binary, XDG_CONFIG_HOME: join(root, "config") };
const version = spawnSync(binary, ["--version"], { cwd, env, encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), installedPiVersion(), "test CLI matches the installed Pi SDK");
const daemon = spawn(process.execPath, [join(pkg, "dist/daemon.js")], { env, stdio: "ignore" });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { if (await ping(paths.socket)) { ready = true; break; } await delay(50); }
  assert.ok(ready, "bundled daemon is ready");
  const host = spawnSync(binary, ["--offline", "--no-extensions", "-e", extension, "--mode", "rpc", "--session", f.snapshot.session.file,
    "--provider", "scheduler-faux", "--model", "source", "--no-skills", "--no-prompt-templates", "--no-themes"],
    { cwd, env, input: "", encoding: "utf8", timeout: 20000 });
  assert.equal(host.status, 0, `stock host: ${host.error || ""}\n${host.stderr}\n${host.stdout}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(result.providerCalls, f.expected.newProviderRequests);
  assert.equal(result.sessionId, f.snapshot.session.id);
  assert.equal(store.listRuns(f.taskId).length, f.expected.terminalTransitions);
  assert.equal(store.getInjection(f.injectionId), undefined);
  console.log(JSON.stringify({ binary, version: version.stdout.trim(), ...result, terminalTransitions: store.listRuns(f.taskId).length,
    scope: "E source callback + real bundled daemon IPC; A1 transport recovery not exercised" }, null, 2));
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
}
