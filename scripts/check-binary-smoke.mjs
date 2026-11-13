import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvironment, piBin, repositoryRoot, workspacePackages } from "./pi-checks.mjs";
import { productionPlugins } from "./pi-binary.mjs";
import { runCommand } from "./pi-upgrade-check.mjs";

const root = await mkdtemp(join(process.env.PI_CHECK_TMPDIR ?? tmpdir(), "binary-smoke-"));
try {
  for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp", "cwd"]) await mkdir(join(root, name));
  const plugins = productionPlugins(workspacePackages(repositoryRoot), await readFile(join(repositoryRoot, "README.md"), "utf8"));
  console.log(`BINARY_PLUGINS ${JSON.stringify(plugins.map(pkg => pkg.name))}`);
  const result = await runCommand(piBin(), [
    "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp", "--no-session",
    ...plugins.flatMap(pkg => ["-e", join(repositoryRoot, pkg.directory)]),
    "-e", join(repositoryRoot, "scripts/fixtures/binary-smoke.ts"),
    "--provider", "binary-faux", "--model", "fixture", "--thinking", "off", "--mode", "json", "-p", "Reply with the offline fixture response.",
  ], { cwd: join(root, "cwd"), env: checkEnvironment(root), log: join(root, "smoke.log"), timeoutMs: 180_000, cleanupPaths: [root], tee: true });
  assert.equal(result.status, "passed", result.output);
  assert.doesNotMatch(result.output, /failed to load extension|^Extension error|uncaughtException/im);
  assert.match(result.stdout, /^BINARY_PERF_TWO_WRITES_OK$/m);
  const events = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === "message_end" && event.message?.role === "assistant" && event.message.content.some(part => part.type === "text" && part.text === "BINARY_SMOKE_OK")), result.output);
  console.log("PASS binary all-plugins / faux session / perf storage ×2");
} finally { await rm(root, { recursive: true, force: true }); }
