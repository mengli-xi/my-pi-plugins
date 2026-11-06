#!/usr/bin/env node
// ExtensionContext exposes a readonly SessionManager. Rewind must rebind the
// concrete manager after rewriting bytes and restore its leaf on undo, so these
// mutation seams remain explicit probes. An optional binary tests its real host.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function checkProbes(SessionManager) {
  const probes = ["setSessionFile", "branch", "resetLeaf"].map((name) => [
    `session-manager.${name}`, SessionManager?.prototype, name,
  ]);
  let failed = false;
  for (const [id, target, member] of probes) {
    const descriptor = target && Object.getOwnPropertyDescriptor(target, member);
    const ok = typeof descriptor?.value === "function" && descriptor.writable === true;
    process.stdout.write(`${ok ? "OK" : "MISSING"} ${id}\n`);
    if (!ok) failed = true;
  }
  return !failed;
}

const binary = process.argv[2];
if (!binary) {
  if (!checkProbes(SessionManager)) process.exitCode = 1;
} else {
  const directory = mkdtempSync(join(tmpdir(), "pi-rewind-host-probe-"));
  try {
    const home = join(directory, "home");
    const agent = join(directory, "agent");
    const sessions = join(directory, "sessions");
    for (const path of [home, agent, sessions]) mkdirSync(path);
    const extension = join(directory, "probe.ts");
    writeFileSync(extension, 'import { SessionManager } from "@earendil-works/pi-coding-agent";' + "\nexport default function () { (" + checkProbes.toString() + ")(SessionManager); }\n");
    const result = spawnSync(binary, ["-ne", "-e", extension, "--session-dir", sessions, "--list-models"], {
      cwd: directory,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_NEXT_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", XDG_CONFIG_HOME: join(directory, "config") },
      encoding: "utf8", timeout: 30_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(output.split("\n").filter((line) => /^(OK|MISSING) /.test(line)).join("\n") + "\n");
    if (result.status !== 0 || (output.match(/^OK /gm) ?? []).length !== 3 || /MISSING/.test(output)) {
      process.stderr.write(output + (result.error?.message ?? ""));
      process.exitCode = 1;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
