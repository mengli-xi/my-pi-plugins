import assert from "node:assert/strict";
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

test("the system notifier is fire-and-forget and never throws without a session", () => {
  // No assertion on delivery: on a headless CI box this must simply not throw.
  assert.doesNotThrow(() => systemNotifier("title", "body"));
});


test("agent profiles have distinct service identities and unit paths", () => {
  const next = { ...spec, agentDir: "/home/u/.pi-next/agent", piBinary: "/home/u/pi-1.2.0" };
  assert.notEqual(serviceLabel(next.agentDir), serviceLabel(spec.agentDir));
  assert.notEqual(launchdPlistPath(next.agentDir), launchdPlistPath(spec.agentDir));
  assert.notEqual(systemdUnitPath(next.agentDir), systemdUnitPath(spec.agentDir));
  assert.ok(launchdPlistPath(next.agentDir).endsWith(`${serviceLabel(next.agentDir)}.plist`));
  assert.ok(systemdUnitPath(next.agentDir).endsWith(systemdUnitName(next.agentDir)));
  const plist = launchdPlist(next);
  assert.ok(plist.includes(`<string>${serviceLabel(next.agentDir)}</string>`));
  assert.ok(plist.includes(`<string>${next.piBinary}</string>`));
});
