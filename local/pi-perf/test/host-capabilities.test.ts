import assert from "node:assert/strict";
import test from "node:test";
import {
  claimHostCapabilityWarning,
  EXTENSION_MODULE_CACHE_POLICY_KEY,
  HOST_CAPABILITY_WARNING_KEY,
  SESSION_REPLACEMENT_GC_METRICS_KEY,
  SESSION_REPLACEMENT_GC_POLICY_KEY,
  readHostReloadCacheStatus,
  readHostSessionReplacementGcMetrics,
} from "../src/host-capabilities.ts";

const gcPolicy = {
  version: 1,
  bunBinary: true,
  disabled: false,
  available: true,
  enabled: true,
};

const gcMetrics = {
  version: 1,
  count: 3,
  totalMs: 30,
  lastMs: 12,
  maxMs: 14,
  lastAt: 1_000,
  lastReason: "new",
};

test("reports the patched Bun cache policy", () => {
  const host: Record<PropertyKey, unknown> = {
    [EXTENSION_MODULE_CACHE_POLICY_KEY]: {
      version: 1,
      bunBinary: true,
      freshReload: false,
      moduleCache: true,
    },
    [SESSION_REPLACEMENT_GC_POLICY_KEY]: gcPolicy,
    [SESSION_REPLACEMENT_GC_METRICS_KEY]: gcMetrics,
  };
  assert.deepEqual(readHostReloadCacheStatus(host, true), {
    healthy: true,
    label: "host reload cache on · replacement GC on · GC new last 12.0ms · avg 10.0ms · max 14.0ms · n 3",
  });
});

test("reads live session-replacement GC metrics on every status query", () => {
  const metrics = { ...gcMetrics };
  const host: Record<PropertyKey, unknown> = {
    [EXTENSION_MODULE_CACHE_POLICY_KEY]: {
      version: 1,
      bunBinary: true,
      freshReload: false,
      moduleCache: true,
    },
    [SESSION_REPLACEMENT_GC_POLICY_KEY]: gcPolicy,
    [SESSION_REPLACEMENT_GC_METRICS_KEY]: metrics,
  };
  assert.match(readHostReloadCacheStatus(host, true).label, /n 3$/);
  metrics.count = 4;
  metrics.totalMs = 35;
  metrics.lastMs = 5;
  metrics.lastReason = "reload";
  assert.match(readHostReloadCacheStatus(host, true).label, /GC reload last 5\.0ms · avg 8\.8ms · max 14\.0ms · n 4$/);
  assert.deepEqual(readHostSessionReplacementGcMetrics(host), metrics);
  assert.notEqual(readHostSessionReplacementGcMetrics(host), metrics);
});

test("rejects malformed host GC metrics", () => {
  assert.equal(readHostSessionReplacementGcMetrics({
    [SESSION_REPLACEMENT_GC_METRICS_KEY]: { ...gcMetrics, totalMs: Number.NaN },
  }), undefined);
});

test("warns when the long-run session-replacement GC policy is missing", () => {
  const host: Record<PropertyKey, unknown> = {
    [EXTENSION_MODULE_CACHE_POLICY_KEY]: {
      version: 1,
      bunBinary: true,
      freshReload: false,
      moduleCache: true,
    },
  };
  const status = readHostReloadCacheStatus(host, true);
  assert.equal(status.healthy, false);
  assert.match(status.label, /replacement GC missing/);
  assert.match(status.warning ?? "", /RSS target/);
});

test("reports an explicit session-replacement GC override without warning", () => {
  const host: Record<PropertyKey, unknown> = {
    [EXTENSION_MODULE_CACHE_POLICY_KEY]: {
      version: 1,
      bunBinary: true,
      freshReload: false,
      moduleCache: true,
    },
    [SESSION_REPLACEMENT_GC_POLICY_KEY]: { ...gcPolicy, disabled: true, enabled: false },
  };
  assert.deepEqual(readHostReloadCacheStatus(host, true), {
    healthy: true,
    label: "host reload cache on · replacement GC off (PI_SESSION_REPLACEMENT_GC=0)",
  });
});

test("treats the explicit fresh reload override as healthy", () => {
  const host: Record<PropertyKey, unknown> = {
    [EXTENSION_MODULE_CACHE_POLICY_KEY]: {
      version: 1,
      bunBinary: true,
      freshReload: true,
      moduleCache: false,
    },
    [SESSION_REPLACEMENT_GC_POLICY_KEY]: gcPolicy,
    [SESSION_REPLACEMENT_GC_METRICS_KEY]: gcMetrics,
  };
  const status = readHostReloadCacheStatus(host, true);
  assert.equal(status.healthy, true);
  assert.match(status.label, /PI_EXTENSION_FRESH_RELOAD=1/);
  assert.match(status.label, /replacement GC on/);
});

test("warns once when a Bun binary loses the host patch", () => {
  const host: Record<PropertyKey, unknown> = {};
  const status = readHostReloadCacheStatus(host, true);
  assert.equal(status.healthy, false);
  assert.match(status.label, /patch missing/);
  assert.match(claimHostCapabilityWarning(status, host) ?? "", /repeated \/reload/);
  assert.equal(claimHostCapabilityWarning(status, host), undefined);
  assert.equal(host[HOST_CAPABILITY_WARNING_KEY], true);
});

test("does not require the Bun-only patch in a Node source runtime", () => {
  assert.deepEqual(readHostReloadCacheStatus({}, false), {
    healthy: true,
    label: "host reload cache n/a (Node/source runtime)",
  });
});
