import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  launchdPlist,
  serviceLabel,
  systemdUnitName,
  launchdPlistPath,
  systemdUnitPath,
  systemdUnit,
  type ServiceSpec,
} from "../src/install-service.ts";
import { systemNotifier } from "../src/notify.ts";

const spec: ServiceSpec = {
  runtime: "/usr/local/bin/node",
  daemonEntry: "/pkg/dist/daemon-entry.js",
  agentDir: "/home/u/.pi/agent",
  piBinary: "/home/u/bin/pi",
  logPath: "/home/u/.pi/agent/scheduler/daemon.log",
  concurrency: 5,
};

test("launchd plist starts at load, keeps alive, and bakes in the env", () => {
  const plist = launchdPlist(spec);
  assert.match(plist, new RegExp(`<string>${serviceLabel(spec.agentDir)}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /PI_CODING_AGENT_DIR<\/key>\s*<string>\/home\/u\/\.pi\/agent<\/string>/);
  assert.match(plist, /PI_SCHEDULER_BINARY<\/key>\s*<string>\/home\/u\/bin\/pi<\/string>/);
  assert.match(plist, /PI_SCHEDULER_CONCURRENCY<\/key>\s*<string>5<\/string>/);
  assert.ok(plist.includes(spec.runtime) && plist.includes(spec.daemonEntry));
});

test("systemd unit restarts always and installs to default.target", () => {
  const unit = systemdUnit(spec);
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/pkg\/dist\/daemon-entry\.js/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Environment=PI_CODING_AGENT_DIR=\/home\/u\/\.pi\/agent/);
  assert.match(unit, /Environment=PI_SCHEDULER_BINARY=\/home\/u\/bin\/pi/);
});

test("plist escapes XML metacharacters in paths", () => {
  const plist = launchdPlist({ ...spec, agentDir: "/home/a&b/<x>" });
  assert.match(plist, /\/home\/a&amp;b\/&lt;x&gt;/);
});

test("omitting concurrency leaves it unset in both unit formats", () => {
  const noConcurrency = { ...spec, concurrency: undefined };
  assert.doesNotMatch(launchdPlist(noConcurrency), /PI_SCHEDULER_CONCURRENCY/);
  assert.doesNotMatch(systemdUnit(noConcurrency), /PI_SCHEDULER_CONCURRENCY/);
});

test("the system notifier is fire-and-forget and never throws without a session", async t => {
  // Stub the desktop notifiers in the test's own PATH so this file never pops a
  // real notification when run alone, on any host.
  const bin = mkdtempSync(join(tmpdir(), "pi-scheduler-notify-bin-"));
  const calls = join(bin, "calls.log");
  for (const name of ["osascript", "notify-send"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "${calls}"\nexit 1\n`, { mode: 0o700 });
  }
  const path = process.env.PATH;
  const restore = () => { process.env.PATH = path; };
  t.after(() => { restore(); rmSync(bin, { recursive: true, force: true }); });
  process.env.PATH = `${bin}:${path ?? ""}`;
  // No assertion on delivery: headless or stubbed, it must simply not throw.
  assert.doesNotThrow(() => systemNotifier("title", "body"));
  // PATH lookup happens in the spawned child, so keep the stub first until the
  // stub itself has actually run. Without this the test could reach a real
  // desktop notifier on the way out.
  if (process.platform === "darwin" || process.platform === "linux") {
    const deadline = Date.now() + 5_000;
    while (!existsSync(calls) && Date.now() < deadline) await delay(25);
    assert.equal(existsSync(calls), true, "the stubbed system notifier handled the request");
  }
  restore();
});
