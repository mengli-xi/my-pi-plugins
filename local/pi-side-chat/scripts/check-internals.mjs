import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = resolve(packageDir, "test", "internals-probe-extension.ts");
const fauxProvider = resolve(packageDir, "test", "faux-provider.ts");
const executable = process.argv[2] ?? process.env.PI_TEST_EXECUTABLE ?? process.env.PI_EXECUTABLE;
if (!executable || !existsSync(executable)) {
  console.error(`Set an existing stock Pi 1.5.0 binary via argument or PI_TEST_EXECUTABLE: ${executable}`);
  process.exit(1);
}
const reportDir = mkdtempSync(join(tmpdir(), "pi-side-chat-probes-"));
const reportFile = join(reportDir, "report.json");
const home = join(reportDir, "home");
mkdirSync(home);
for (const name of ["tmp", "config", "cache", "state", "data"]) mkdirSync(join(reportDir, name));
try {
  const result = spawnSync(executable, [
    "-ne",
    "--no-session",
    "--session-dir", join(reportDir, "sessions"),
    "-e", extension,
    "-e", fauxProvider,
    "--provider", "side-faux",
    "--model", "side-faux-1",
    "--offline",
    "-p", "probe",
  ], {
    cwd: reportDir,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      HOME: home,
      TMPDIR: join(reportDir, "tmp"),
      XDG_CONFIG_HOME: join(reportDir, "config"),
      XDG_CACHE_HOME: join(reportDir, "cache"),
      XDG_STATE_HOME: join(reportDir, "state"),
      XDG_DATA_HOME: join(reportDir, "data"),
      PI_CODING_AGENT_DIR: join(reportDir, "agent"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SIDECHAT_PROBE_REPORT: reportFile,
    },
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pi probe process exited ${result.status ?? result.signal ?? "unknown"}`);
  if (!existsSync(reportFile)) throw new Error("Side Chat probe extension did not report completion");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const expected = ["side-chat.child.render-session-entries", "side-chat.child.compaction-display"];
  if (!report.ok || report.version !== "1.5.0" || JSON.stringify(report.probes) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected Side Chat probe report: ${JSON.stringify(report)}`);
  }
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
