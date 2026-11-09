import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorRuntime } from "./runtime.js";
import { parseExecutionIsolationBootstrap, SUPERVISOR_EXECUTION_ISOLATION_ENV } from "../execution-isolation.js";

const HOST_NONCE = /^[0-9a-f]{64}$/;

const probeIndex = process.argv.indexOf("--runtime-probe");
if (probeIndex >= 0) {
  const nonce = process.argv[probeIndex + 1];
  if (!nonce || !/^[0-9a-f]{32}$/.test(nonce)) process.exit(64);
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  const engine = bun ? "bun" : "node";
  const version = bun?.version ?? process.versions.node;
  process.stdout.write(`pi-processes-runtime-v1 ${nonce} ${engine} ${version}\n`);
  process.exit(0);
}

const hostNonce = process.env.PI_PROCESSES_SUPERVISOR_NONCE;
const generation = Number(process.env.PI_PROCESSES_SUPERVISOR_GENERATION);
const sessionScopeId = process.env.PI_PROCESSES_SESSION_SCOPE;
const piPid = Number(process.env.PI_PROCESSES_PI_PID);
const root = process.env.PI_PROCESSES_SUPERVISOR_ROOT;
// A packaged host executable may not be an independently executable JS runtime.
// Carry the Host's verified helper path to matcher workers; only a standalone
// launch without an override may fall back to process.execPath.
const helperRuntime = process.env.PI_PROCESSES_SUPERVISOR_HELPER_RUNTIME ?? process.execPath;
if (!isAbsolute(helperRuntime) || /[\u0000-\u001f\u007f]/u.test(helperRuntime)) {
  process.stderr.write("[process/protocol-handshake] invalid supervisor helper runtime\n");
  process.exit(64);
}
try {
  if (!(await stat(helperRuntime)).isFile()) throw new Error("helper runtime must be a file");
  await access(helperRuntime, constants.X_OK);
} catch (error) {
  process.stderr.write(`[process/protocol-handshake] invalid supervisor helper runtime: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(64);
}
if (!hostNonce || !HOST_NONCE.test(hostNonce)
  || !Number.isSafeInteger(generation) || generation <= 0
  || !sessionScopeId || sessionScopeId.length > 256
  || !Number.isSafeInteger(piPid) || piPid <= 0
  || !root) {
  process.stderr.write("[process/protocol-handshake] invalid supervisor launch environment\n");
  process.exit(64);
}

let isolation;
try {
  isolation = parseExecutionIsolationBootstrap(process.env[SUPERVISOR_EXECUTION_ISOLATION_ENV]).policy ?? undefined;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(64);
}

const runtime = new SupervisorRuntime({
  root,
  hostNonce,
  supervisorGeneration: generation,
  sessionScopeId,
  piPid,
  matcherRuntimePath: helperRuntime,
  matcherWorkerPath: fileURLToPath(new URL("./matcher-worker.js", import.meta.url)),
  isolation,
});
await runtime.start();
