export const EXTENSION_MODULE_CACHE_POLICY_KEY = Symbol.for("pi.extension-module-cache-policy.v1");
export const SESSION_REPLACEMENT_GC_POLICY_KEY = Symbol.for("pi.session-replacement-gc-policy.v1");
export const SESSION_REPLACEMENT_GC_METRICS_KEY = Symbol.for("pi.session-replacement-gc-metrics.v1");
export const HOST_CAPABILITY_WARNING_KEY = Symbol.for("pi.perf.host-capability-warning.v1");

interface ExtensionModuleCachePolicyV1 {
  version: 1;
  bunBinary: boolean;
  freshReload: boolean;
  moduleCache: boolean;
}

interface SessionReplacementGcPolicyV1 {
  version: 1;
  bunBinary: boolean;
  disabled: boolean;
  available: boolean;
  enabled: boolean;
}

export interface SessionReplacementGcMetricsV1 {
  version: 1;
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
  lastAt: number;
  lastReason?: "new" | "resume" | "fork" | "reload";
}

export interface HostReloadCacheStatus {
  healthy: boolean;
  label: string;
  warning?: string;
}

function isPolicy(value: unknown): value is ExtensionModuleCachePolicyV1 {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Partial<ExtensionModuleCachePolicyV1>;
  return policy.version === 1 &&
    typeof policy.bunBinary === "boolean" &&
    typeof policy.freshReload === "boolean" &&
    typeof policy.moduleCache === "boolean";
}

function isGcPolicy(value: unknown): value is SessionReplacementGcPolicyV1 {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Partial<SessionReplacementGcPolicyV1>;
  return policy.version === 1 &&
    typeof policy.bunBinary === "boolean" &&
    typeof policy.disabled === "boolean" &&
    typeof policy.available === "boolean" &&
    typeof policy.enabled === "boolean";
}

function isGcMetrics(value: unknown): value is SessionReplacementGcMetricsV1 {
  if (typeof value !== "object" || value === null) return false;
  const metrics = value as Partial<SessionReplacementGcMetricsV1>;
  return metrics.version === 1 &&
    Number.isInteger(metrics.count) &&
    typeof metrics.count === "number" && metrics.count >= 0 &&
    typeof metrics.totalMs === "number" && Number.isFinite(metrics.totalMs) && metrics.totalMs >= 0 &&
    typeof metrics.lastMs === "number" && Number.isFinite(metrics.lastMs) && metrics.lastMs >= 0 &&
    typeof metrics.maxMs === "number" && Number.isFinite(metrics.maxMs) && metrics.maxMs >= 0 &&
    typeof metrics.lastAt === "number" && Number.isFinite(metrics.lastAt) && metrics.lastAt >= 0 &&
    (metrics.lastReason === undefined || ["new", "resume", "fork", "reload"].includes(metrics.lastReason));
}

export function readHostSessionReplacementGcMetrics(
  host: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>,
): SessionReplacementGcMetricsV1 | undefined {
  const metrics = host[SESSION_REPLACEMENT_GC_METRICS_KEY];
  return isGcMetrics(metrics) ? { ...metrics } : undefined;
}

function gcMetricsLabel(host: Record<PropertyKey, unknown>): string {
  const metrics = readHostSessionReplacementGcMetrics(host);
  if (!metrics) return "GC metrics missing";
  if (metrics.count === 0) return "GC n 0";
  const averageMs = metrics.totalMs / metrics.count;
  const reason = metrics.lastReason ? ` ${metrics.lastReason}` : "";
  return `GC${reason} last ${metrics.lastMs.toFixed(1)}ms · avg ${averageMs.toFixed(1)}ms · max ${metrics.maxMs.toFixed(1)}ms · n ${metrics.count}`;
}

function withGcStatus(
  cacheLabel: string,
  host: Record<PropertyKey, unknown>,
): HostReloadCacheStatus {
  const value = host[SESSION_REPLACEMENT_GC_POLICY_KEY];
  if (!isGcPolicy(value)) {
    return {
      healthy: false,
      label: `${cacheLabel} · replacement GC ${value === undefined ? "missing" : "incompatible"}`,
      warning: "patched Bun session-replacement GC is missing or incompatible; long-running sessions can exceed the RSS target",
    };
  }
  if (!value.bunBinary) return { healthy: true, label: `${cacheLabel} · replacement GC n/a` };
  if (value.disabled) {
    return { healthy: true, label: `${cacheLabel} · replacement GC off (PI_SESSION_REPLACEMENT_GC=0)` };
  }
  if (value.enabled && value.available) {
    return { healthy: true, label: `${cacheLabel} · replacement GC on · ${gcMetricsLabel(host)}` };
  }
  return {
    healthy: false,
    label: `${cacheLabel} · replacement GC unavailable`,
    warning: "Bun session-replacement GC is unavailable; long-running sessions can exceed the RSS target",
  };
}

export function readHostReloadCacheStatus(
  host: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>,
  bunRuntime = "Bun" in globalThis,
): HostReloadCacheStatus {
  const value = host[EXTENSION_MODULE_CACHE_POLICY_KEY];
  if (value === undefined && !bunRuntime) {
    return { healthy: true, label: "host reload cache n/a (Node/source runtime)" };
  }
  if (!isPolicy(value)) {
    return {
      healthy: false,
      label: value === undefined ? "host reload cache patch missing" : "host reload cache policy incompatible",
      warning: "patched Bun extension reload cache is missing or incompatible; repeated /reload can retain another extension module graph",
    };
  }
  if (!value.bunBinary) {
    return { healthy: true, label: "host reload cache n/a (Node/source runtime)" };
  }
  if (value.freshReload) {
    return withGcStatus("host reload cache fresh (PI_EXTENSION_FRESH_RELOAD=1)", host);
  }
  if (value.moduleCache) {
    return withGcStatus("host reload cache on", host);
  }
  return {
    healthy: false,
    label: "host reload cache unexpectedly off",
    warning: "Bun extension module caching is unexpectedly disabled; repeated /reload can retain another extension module graph",
  };
}

export function claimHostCapabilityWarning(
  status: HostReloadCacheStatus,
  host: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>,
): string | undefined {
  if (status.healthy || !status.warning || host[HOST_CAPABILITY_WARNING_KEY] === true) return undefined;
  host[HOST_CAPABILITY_WARNING_KEY] = true;
  return status.warning;
}
