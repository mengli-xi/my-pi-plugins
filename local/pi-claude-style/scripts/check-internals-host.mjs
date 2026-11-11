import { piBin } from "../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "dist", "index.ts");
const probesUrl = pathToFileURL(join(packageRoot, "dist", "src", "probes.ts")).href;
const internalsUrl = pathToFileURL(join(packageRoot, "dist", "src", "internals.ts")).href;
const binary = piBin();
if (!existsSync(extensionPath)) {
  console.error(`production build not found: ${extensionPath}; run npm run build first`);
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "pi-claude-style-host-internals-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const tempDir = join(root, "tmp");
const resultPath = join(root, "result.json");
const probePath = join(root, "probe.ts");
for (const path of [home, agentDir, sessionDir, tempDir]) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

await writeFile(probePath, `
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Container } from "@earendil-works/pi-tui";
import { ALL_PROBES } from ${JSON.stringify(probesUrl)};
import { AssistantMessageComponent, getPackageDir, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  auditInternals,
  currentPiVersion,
  declareProbes,
} from ${JSON.stringify(internalsUrl)};
export default function hostInternalsProbe(pi) {
  pi.on("session_start", async () => {
    declareProbes(ALL_PROBES);
    const initialUnhealthy = auditInternals().filter(row => row.state === "missing" || row.state === "broken").map(row => row.id);
    // Reproduce 1.5's bare-subpath alias separately, without hiding production failures.
    let legacyLayoutError;
    try { await import("@earendil-works/pi-tui/dist/layout.js"); } catch (error) { legacyLayoutError = String(error); }
    let layoutUrl, layoutError, layoutFallback = false;
    try {
      const entry = createRequire(join(getPackageDir(), "package.json")).resolve("@earendil-works/pi-tui");
      layoutUrl = new URL("./layout.js", pathToFileURL(entry)).href;
      const layout = await import(layoutUrl);
      const root = new Container(), frame = layout.renderLayoutFrame(root, 80, 24, () => {});
      layoutFallback = frame.root.component === root && frame.width === 80 && frame.height === 24;
    } catch (error) { layoutError = String(error); }
    // The old synchronous snapshot could finish before production's lazy import rejected.
    await new Promise(done => setImmediate(done));
    const rows = auditInternals();
    const eager = rows.filter((row) => typeof row.check === "function");
    writeFileSync(process.env.PI_INTERNALS_HOST_RESULT, JSON.stringify({
      version: currentPiVersion(),
      eagerCount: eager.length,
      initialUnhealthy,
      legacyLayoutError,
      layoutUrl,
      layoutError,
      layoutFallback,
      hostIdentity: [...(globalThis[Symbol.for("pi.claude-style.presentation-owners.v1")]?.owners ?? [])].some((owner) =>
        owner.locals.has(AssistantMessageComponent.prototype) &&
        owner.locals.get(UserMessageComponent.prototype)?.[Symbol.for("pi-claude-transcript.user-message.patch")] !== undefined),
      unhealthy: rows.filter((row) =>
        row.state === "missing" || row.state === "broken"
      ).map((row) => ({
        id: row.id,
        state: row.state,
        detail: row.detail,
      })),
    }, null, 2));
  });
}
`, { mode: 0o600 });

let child;
let closed;
try {
  child = spawn(binary, [
    "--mode", "rpc",
    "--offline",
    "--no-session",
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--extension", extensionPath,
    "--extension", probePath,
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      TMPDIR: tempDir,
      PI_INTERNALS_HOST_RESULT: resultPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let buffer = "";
  let response;
  let processError;
  let protocolError;
  let exit;
  closed = new Promise((resolveExit) => {
    child.once("close", (code, signal) => {
      exit = { code, signal };
      resolveExit(exit);
    });
  });
  child.once("error", (error) => { processError = error; });
  child.stdin.on("error", (error) => { processError = error; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record.id === "host-internals") response = record;
      } catch (error) {
        protocolError = error;
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ id: "host-internals", type: "get_state" })}\n`);

  const responseDeadline = Date.now() + 30_000;
  while (!response && !processError && !protocolError && !exit && Date.now() < responseDeadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
  if (processError) throw processError;
  if (protocolError) throw protocolError;
  assert.ok(response, `get_state timed out or Pi exited\n${stderr}\n${stdout}`);
  assert.equal(response.success, true, JSON.stringify(response));
  child.stdin.end();

  let exitTimer;
  const exitTimeout = new Promise((_, reject) => {
    exitTimer = setTimeout(
      () => reject(new Error(`Pi did not exit\n${stderr}\n${stdout}`)),
      30_000,
    );
  });
  try {
      exit = await Promise.race([closed, exitTimeout]);
  } finally {
    clearTimeout(exitTimer);
  }
  if (processError) throw processError;
  if (protocolError) throw protocolError;
  assert.equal(buffer, "", `incomplete RPC stdout: ${JSON.stringify(buffer)}`);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(stderr, "", stderr);
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.ok(result.eagerCount > 0, JSON.stringify(result));
  assert.equal(result.hostIdentity, true, "production bundle must patch the final host's own components");
  assert.equal(result.layoutFallback, true, JSON.stringify(result));
  assert.deepEqual(result.unhealthy, [], JSON.stringify(result));
  console.log(
    `pi ${result.version} bundled host · ${result.eagerCount} eager internals ok · public renderer resolver · layout fallback ok${result.legacyLayoutError?.includes("index.js/dist/layout.js") ? " (legacy alias reproduced)" : ""}`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (closed) {
    await Promise.race([
      closed,
      new Promise((done) => setTimeout(done, 3_000)),
    ]);
  }
  await rm(root, { recursive: true, force: true });
}
