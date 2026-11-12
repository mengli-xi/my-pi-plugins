/**
 * Process-wide, provider-owned telemetry for independently loaded plugins.
 *
 * Producers discover this API through a global symbol and keep only a bound
 * reporter. They never own timers, logs, or aggregation state. The provider
 * may be loaded after a producer, so consumers must treat the protocol as
 * optional and retry discovery at a later observation boundary.
 */

export const PERF_TELEMETRY_KEY = Symbol.for("pi.perf.telemetry.v1");

export type TelemetryAttribute = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryAttribute | undefined>;

export interface TelemetryProducerConfig {
  sampleWindow: number;
  slowSampleMs: number;
  logEnabled: boolean;
}

export interface TelemetryMetricStats {
  owner: string;
  name: string;
  count: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TelemetryObservationStats {
  owner: string;
  name: string;
  unit: string;
  count: number;
  last: number;
  p50: number;
  p95: number;
  max: number;
}

export interface TelemetryCounter {
  owner: string;
  name: string;
  value: number;
}

export interface TelemetryGauge {
  owner: string;
  name: string;
  unit: string;
  value: number;
  peak: number;
}

export interface TelemetrySnapshot {
  at: number;
  owners: string[];
  measures: TelemetryMetricStats[];
  observations: TelemetryObservationStats[];
  counters: TelemetryCounter[];
  gauges: TelemetryGauge[];
}

export interface TelemetrySample {
  owner: string;
  kind: "measure" | "observation" | "counter" | "gauge";
  name: string;
  value: number;
  unit: string;
  attributes?: TelemetryAttributes;
  logEnabled: boolean;
  slowSampleMs: number;
}

export interface TelemetryReporter {
  configure(config: Partial<TelemetryProducerConfig>): void;
  measure(name: string, ms: number, attributes?: TelemetryAttributes): void;
  increment(name: string, delta?: number): void;
  observe(name: string, value: number, unit: string): void;
  gauge(name: string, value: number, unit: string): void;
}

export interface TelemetryReporterHandle {
  reporter: TelemetryReporter;
  release(): void;
}

export interface TelemetryRegistryV1 {
  version: 1;
  acquireReporter(owner: string): TelemetryReporterHandle;
  acquireObserver(owner: string, observer: (sample: TelemetrySample) => void): () => void;
  snapshot(owner?: string): TelemetrySnapshot;
  reset(owner: string): void;
  resetAll(requester: string): void;
  setEnabled(enabled: boolean, providerOwner: string): void;
  getStatus(): { provider: string; enabled: boolean; producers: number; observers: number };
}

interface Series {
  count: number;
  last: number;
  max: number;
  recent: number[];
  unit: string;
}

interface GaugeState {
  value: number;
  peak: number;
  unit: string;
}

interface RegistryState {
  enabledOwners: Set<string>;
  providerOwners: Set<string>;
  producerRefs: Map<string, number>;
  observers: Map<number, { owner: string; observer: (sample: TelemetrySample) => void }>;
  configs: Map<string, TelemetryProducerConfig>;
  measures: Map<string, Series>;
  observations: Map<string, Series>;
  counters: Map<string, number>;
  gauges: Map<string, GaugeState>;
  nextObserverId: number;
}

const DEFAULT_CONFIG: TelemetryProducerConfig = {
  sampleWindow: 512,
  slowSampleMs: 50,
  logEnabled: false,
};
const MAX_NAME = 160;
const MAX_OWNER = 80;
const MAX_UNIT = 24;
const MAX_ATTRIBUTE_NAME = 64;
const MAX_ATTRIBUTE_STRING = 160;

let owned: { api: TelemetryRegistryV1; state: RegistryState } | undefined;

function boundedText(value: string, max: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function safeAttributes(attributes?: TelemetryAttributes): TelemetryAttributes | undefined {
  if (!attributes) return undefined;
  const safe: TelemetryAttributes = {};
  for (const [rawName, rawValue] of Object.entries(attributes).slice(0, 16)) {
    const name = boundedText(rawName, MAX_ATTRIBUTE_NAME);
    if (!name || rawValue === undefined) continue;
    if (typeof rawValue === "string") safe[name] = rawValue.slice(0, MAX_ATTRIBUTE_STRING);
    else if (typeof rawValue === "boolean") safe[name] = rawValue;
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) safe[name] = rawValue;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function key(owner: string, name: string): string {
  return `${owner}\0${name}`;
}

function splitKey(value: string): [string, string] {
  const index = value.indexOf("\0");
  return [value.slice(0, index), value.slice(index + 1)];
}

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const rank = Math.ceil(samples.length * p / 100);
  return samples[Math.max(0, Math.min(samples.length - 1, rank - 1))] ?? 0;
}

function configFor(state: RegistryState, owner: string): TelemetryProducerConfig {
  let config = state.configs.get(owner);
  if (!config) {
    config = { ...DEFAULT_CONFIG };
    state.configs.set(owner, config);
  }
  return config;
}

function recordSeries(series: Map<string, Series>, seriesKey: string, value: number, unit: string, window: number): void {
  const current = series.get(seriesKey) ?? {
    count: 0,
    last: 0,
    max: Number.NEGATIVE_INFINITY,
    recent: [],
    unit,
  };
  current.count++;
  current.last = value;
  current.max = Math.max(current.max, value);
  current.unit = unit;
  current.recent.push(value);
  if (current.recent.length > window) current.recent.splice(0, current.recent.length - window);
  series.set(seriesKey, current);
}

function notify(state: RegistryState, sample: TelemetrySample): void {
  for (const { observer } of state.observers.values()) {
    try { observer(sample); } catch {}
  }
}

function clearOwner(state: RegistryState, owner: string): void {
  const prefix = `${owner}\0`;
  for (const collection of [state.measures, state.observations, state.counters, state.gauges]) {
    for (const name of collection.keys()) {
      if (name.startsWith(prefix)) collection.delete(name);
    }
  }
}

function snapshot(state: RegistryState, ownerFilter?: string): TelemetrySnapshot {
  const accept = (owner: string) => ownerFilter === undefined || owner === ownerFilter;
  const measures = [...state.measures].flatMap(([seriesKey, value]) => {
    const [owner, name] = splitKey(seriesKey);
    if (!accept(owner)) return [];
    const sorted = [...value.recent].sort((left, right) => left - right);
    return [{ owner, name, count: value.count, lastMs: value.last, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), maxMs: value.max }];
  });
  const observations = [...state.observations].flatMap(([seriesKey, value]) => {
    const [owner, name] = splitKey(seriesKey);
    if (!accept(owner)) return [];
    const sorted = [...value.recent].sort((left, right) => left - right);
    return [{ owner, name, unit: value.unit, count: value.count, last: value.last, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: value.max }];
  });
  const counters = [...state.counters].flatMap(([seriesKey, value]) => {
    const [owner, name] = splitKey(seriesKey);
    return accept(owner) ? [{ owner, name, value }] : [];
  });
  const gauges = [...state.gauges].flatMap(([seriesKey, value]) => {
    const [owner, name] = splitKey(seriesKey);
    return accept(owner) ? [{ owner, name, ...value }] : [];
  });
  const owners = new Set<string>();
  for (const owner of state.producerRefs.keys()) if (accept(owner)) owners.add(owner);
  for (const row of [...measures, ...observations, ...counters, ...gauges]) owners.add(row.owner);
  return { at: Date.now(), owners: [...owners].sort(), measures, observations, counters, gauges };
}

function createRegistry(): { api: TelemetryRegistryV1; state: RegistryState } {
  const state: RegistryState = {
    enabledOwners: new Set(),
    providerOwners: new Set(),
    producerRefs: new Map(),
    observers: new Map(),
    configs: new Map(),
    measures: new Map(),
    observations: new Map(),
    counters: new Map(),
    gauges: new Map(),
    nextObserverId: 1,
  };
  const isEnabled = () => state.enabledOwners.size > 0;
  const api: TelemetryRegistryV1 = {
    version: 1,
    acquireReporter(rawOwner) {
      const owner = boundedText(rawOwner, MAX_OWNER);
      if (!owner) throw new Error("telemetry owner is required");
      state.producerRefs.set(owner, (state.producerRefs.get(owner) ?? 0) + 1);
      let active = true;
      const emit = (kind: TelemetrySample["kind"], rawName: string, value: number, rawUnit: string, attributes?: TelemetryAttributes) => {
        if (!active || !isEnabled() || !Number.isFinite(value)) return;
        const name = boundedText(rawName, MAX_NAME);
        const unit = boundedText(rawUnit, MAX_UNIT);
        if (!name || !unit) return;
        const config = configFor(state, owner);
        const seriesKey = key(owner, name);
        if (kind === "measure") recordSeries(state.measures, seriesKey, value, unit, config.sampleWindow);
        else if (kind === "observation") recordSeries(state.observations, seriesKey, value, unit, config.sampleWindow);
        else if (kind === "counter") state.counters.set(seriesKey, (state.counters.get(seriesKey) ?? 0) + value);
        else {
          const previous = state.gauges.get(seriesKey);
          state.gauges.set(seriesKey, { value, peak: Math.max(previous?.peak ?? value, value), unit });
        }
        notify(state, {
          owner,
          kind,
          name,
          value,
          unit,
          attributes: safeAttributes(attributes),
          logEnabled: config.logEnabled,
          slowSampleMs: config.slowSampleMs,
        });
      };
      const reporter: TelemetryReporter = {
        configure(next) {
          if (!active) return;
          const current = configFor(state, owner);
          if (Number.isFinite(next.sampleWindow)) current.sampleWindow = Math.max(16, Math.min(10_000, Math.trunc(next.sampleWindow!)));
          if (Number.isFinite(next.slowSampleMs)) current.slowSampleMs = Math.max(1, Math.min(60_000, next.slowSampleMs!));
          if (typeof next.logEnabled === "boolean") current.logEnabled = next.logEnabled;
        },
        measure: (name, ms, attributes) => emit("measure", name, ms, "ms", attributes),
        increment: (name, delta = 1) => { if (delta !== 0) emit("counter", name, delta, "count"); },
        observe: (name, value, unit) => emit("observation", name, value, unit),
        gauge: (name, value, unit) => emit("gauge", name, value, unit),
      };
      return {
        reporter,
        release() {
          if (!active) return;
          active = false;
          const remaining = (state.producerRefs.get(owner) ?? 1) - 1;
          if (remaining > 0) state.producerRefs.set(owner, remaining);
          else state.producerRefs.delete(owner);
        },
      };
    },
    acquireObserver(owner, observer) {
      const id = state.nextObserverId++;
      state.observers.set(id, { owner, observer });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        state.observers.delete(id);
      };
    },
    snapshot: (owner) => snapshot(state, owner),
    reset: (owner) => clearOwner(state, owner),
    resetAll(requester) {
      if (!state.providerOwners.has(requester)) return;
      state.measures.clear();
      state.observations.clear();
      state.counters.clear();
      state.gauges.clear();
    },
    setEnabled(enabled, providerOwner) {
      state.providerOwners.add(providerOwner);
      if (enabled) state.enabledOwners.add(providerOwner);
      else state.enabledOwners.delete(providerOwner);
    },
    getStatus: () => ({
      provider: "pi-perf",
      enabled: isEnabled(),
      producers: state.producerRefs.size,
      observers: state.observers.size,
    }),
  };
  return { api, state };
}

/** Create or return the sole process-wide provider registry. */
export function getTelemetryRegistry(): TelemetryRegistryV1 {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = host[PERF_TELEMETRY_KEY];
  if (owned && existing === owned.api) return owned.api;
  if (existing && typeof existing === "object") {
    const candidate = existing as Partial<TelemetryRegistryV1>;
    if (candidate.version === 1 && typeof candidate.acquireReporter === "function" &&
      typeof candidate.acquireObserver === "function" && typeof candidate.snapshot === "function" &&
      typeof candidate.reset === "function" && typeof candidate.resetAll === "function" &&
      typeof candidate.setEnabled === "function" && typeof candidate.getStatus === "function") {
      return candidate as TelemetryRegistryV1;
    }
    throw new Error("incompatible object already owns pi.perf.telemetry.v1");
  }
  owned = createRegistry();
  host[PERF_TELEMETRY_KEY] = owned.api;
  return owned.api;
}
