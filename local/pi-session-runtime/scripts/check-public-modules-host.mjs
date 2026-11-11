import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnvironment, installedPiVersion, piBin } from "../../../scripts/pi-checks.mjs";

const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-module-host-"));
try {
  for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(root, name));
  const result = spawnSync(piBin(), [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session",
    "-e", fileURLToPath(new URL("../test/fixtures/public-module-host.ts", import.meta.url)), "--list-models",
  ], { cwd: root, env: checkEnvironment(root), encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
  // A failed extension may leave --list-models with exit 0: require its success proof.
  const reports = [...output.matchAll(/^PI_PUBLIC_MODULE_IDENTITY (.+)$/gm)];
  assert.equal(reports.length, 1, output);
  const report = JSON.parse(reports[0][1]);
  assert.deepEqual(report, { version: installedPiVersion(), StringEnum: true, openAIResponsesApi: true });
  console.log(`PASS Main/child module identity: ${piBin()} ${JSON.stringify(report)}`);
} finally { rmSync(root, { recursive: true, force: true }); }
