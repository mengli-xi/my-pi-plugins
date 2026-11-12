import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("optional launcher reads epoch once, execs only the explicit fixture and preserves arguments", t => {
  const launcher = fileURLToPath(new URL("../bin/pi-launcher.zsh", import.meta.url));
  const source = readFileSync(launcher, "utf8");
  assert.equal((source.match(/\$\{EPOCHREALTIME/g) ?? []).length, 1);
  if (!existsSync("/bin/zsh")) { t.skip("optional zsh launcher requires /bin/zsh"); return; }
  const directory = mkdtempSync(join(tmpdir(), "perf-launcher-"));
  try {
    const binary = join(directory, "fake-pi");
    writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$PI_PERF_LAUNCH_EPOCH_US" "$@"\n', { mode: 0o700 });
    const before = Date.now();
    const result = spawnSync("/bin/zsh", ["-f", launcher, "arg with spaces"], {
      env: { HOME: directory, PATH: "/usr/bin:/bin", PI_PERF_REAL_PI: binary }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const [epoch, argument] = result.stdout.trim().split("\n");
    assert.match(epoch, /^\d{16}$/); assert.equal(argument, "arg with spaces");
    assert.ok(Number(epoch) / 1000 >= before - 1 && Number(epoch) / 1000 <= Date.now() + 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
