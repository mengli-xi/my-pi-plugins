// Real PTY, no provider request. The test-side frame hook is installed before
// InteractiveMode starts; production remains limited to the public widget API.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkEnvironment, installedPiVersion } from "../../../scripts/pi-checks.mjs";

if (!process.env.PI_BIN) throw new Error("use check:host via the root runner");
const root = mkdtempSync(join(tmpdir(), "perf-pty-"));
for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(root, name));
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-perf-pty-probe", type: "module", pi: { extensions: ["./probe.ts"] } }));
const evidence = join(root, "frames.json");
const extension = join(root, "probe.ts");
writeFileSync(join(root, "agent/settings.json"), JSON.stringify({ quietStartup: true, packages: [], retry: { enabled: false }, cacheWarming: "off" }));
writeFileSync(extension, `import { TuiMainScreen, TuiAltScreen } from "@earendil-works/pi-tui";
import { writeFileSync, renameSync } from "node:fs";
import perf from ${JSON.stringify(resolve("index.ts"))};
export default function(pi) {
  const evidence = ${JSON.stringify(evidence)};
  const state = { frames: 0 };
  const save = () => { writeFileSync(evidence + ".tmp", JSON.stringify(state), { mode: 0o600 }); renameSync(evidence + ".tmp", evidence); };
  for (const prototype of [TuiMainScreen.prototype, TuiAltScreen.prototype]) {
    const original = prototype.doRender;
    prototype.doRender = function(...args) {
      const result = original.apply(this, args);
      const at = performance.now();
      state.frames++; state.firstFrameAt ??= at;
      if (state.readyAt !== undefined) state.firstAfterReadyAt ??= at;
      save(); return result;
    };
  }
  perf(pi);
  pi.on("session_start", (event, ctx) => { state.readyAt = performance.now(); state.framesAtReady = state.frames; state.reason = event.reason; state.mode = ctx.mode; save(); });
  pi.registerCommand("perf-probe-quit", { handler: async (_args, ctx) => ctx.shutdown() });
}
`);
let child;
try {
  child = Bun.spawn({ cmd: [process.env.PI_BIN, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--no-tools", "-e", root, "--tui-mode", "fullscreen"],
    cwd: root, env: checkEnvironment(root), stdin: "ignore", stderr: "pipe",
    terminal: { cols: 100, rows: 28, data() {} } });
  const stderr = new Response(child.stderr).text();
  let state, startup;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`PTY host exited ${child.exitCode}: ${await stderr}`);
    try {
      state = JSON.parse(readFileSync(evidence, "utf8"));
      startup = readdirSync(join(root, "agent/perf/raw")).filter(file => file.endsWith(".jsonl"))
        .flatMap(file => readFileSync(join(root, "agent/perf/raw", file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)))
        .find(row => row.kind === "startup" && row.values.firstObservedFrameMs !== undefined);
      if (startup && state.firstAfterReadyAt !== undefined) break;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  assert.ok(startup, "first observed startup paint must be persisted");
  assert.equal(startup.piVersion, installedPiVersion());
  assert.equal(state.reason, "startup"); assert.equal(state.mode, "tui"); assert.equal(startup.mode, "tui");
  assert.ok(state.framesAtReady > 0, `stock Pi ${installedPiVersion()} must paint before session_start; recheck the observed-frame boundary if this changes`);
  assert.ok(startup.values.firstObservedFrameMs >= state.firstAfterReadyAt);
  assert.ok(startup.values.firstObservedFrameMs > state.firstFrameAt);
  console.log("METRIC package-resolution-ms (TUI)", startup.packageResolveMs);
  child.terminal.write("/perf-probe-quit\r");
  let timeout;
  try { await Promise.race([child.exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("PTY shutdown timeout")), 30_000); })]); }
  finally { clearTimeout(timeout); }
  assert.equal(child.exitCode, 0, await stderr);
  console.log(`OK perf.PTY-first-observed-frame: firstObservedFrameMs is the first observable session-ready frame, NOT the process's first frame (stock Pi ${installedPiVersion()} observed lifecycle)`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (child) await child.exited;
  rmSync(root, { recursive: true, force: true });
}
