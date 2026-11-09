import { performance } from "node:perf_hooks";
import { PERF_REGISTRY_KEY, PERF_TELEMETRY_KEY } from "./integration-contracts.ts";

const OWNER = "pi-claude-style";

interface MetricStats {
	name: string;
	count: number;
	lastMs: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

interface SharedUiRegistry {
	version: 3;
	getStatus(): {
		requestRender: boolean;
		doRender: boolean;
		handleTerminalInput: boolean;
		provider: string;
		enabled: boolean;
		subscribers: number;
		detail?: string;
	};
	snapshot(): {
		at: number;
		metrics: MetricStats[];
		owners: string[];
		runtime?: {
			at: number;
			rssBytes: number;
			heapUsedBytes: number;
			externalBytes: number;
			arrayBuffersBytes: number;
			eventLoopUtilization: number;
			eventLoopDelayP95Ms?: number;
		};
	};
}

interface TelemetryMeasure extends MetricStats {
	owner: string;
}

interface TelemetryObservation {
	owner: string;
	name: string;
	unit: string;
	count: number;
	last: number;
	p50: number;
	p95: number;
	max: number;
}

interface TelemetryCounter {
	owner: string;
	name: string;
	value: number;
}

interface TelemetryGauge {
	owner: string;
	name: string;
	unit: string;
	value: number;
	peak: number;
}

interface TelemetryReporter {
	configure(config: { sampleWindow: number; slowSampleMs: number; logEnabled: boolean }): void;
	measure(name: string, ms: number, attributes?: Record<string, string | number | boolean | undefined>): void;
	increment(name: string, delta?: number): void;
	observe(name: string, value: number, unit: string): void;
	gauge(name: string, value: number, unit: string): void;
}

interface TelemetryRegistry {
	version: 1;
	acquireReporter(owner: string): { reporter: TelemetryReporter; release(): void };
	snapshot(owner?: string): {
		at: number;
		owners: string[];
		measures: TelemetryMeasure[];
		observations: TelemetryObservation[];
		counters: TelemetryCounter[];
		gauges: TelemetryGauge[];
	};
	reset(owner: string): void;
	getStatus(): { provider: string; enabled: boolean; producers: number; observers: number };
}

function megabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function sharedUiRegistry(): SharedUiRegistry | undefined {
	const value = (globalThis as Record<PropertyKey, unknown>)[PERF_REGISTRY_KEY];
	if (!value || typeof value !== "object") return undefined;
	const registry = (value as { api?: unknown }).api ?? value;
	if (!registry || typeof registry !== "object" || (registry as { version?: unknown }).version !== 3) return undefined;
	const candidate = registry as Partial<SharedUiRegistry>;
	return typeof candidate.getStatus === "function" && typeof candidate.snapshot === "function"
		? candidate as SharedUiRegistry
		: undefined;
}

function sharedTelemetryRegistry(): TelemetryRegistry | undefined {
	const value = (globalThis as Record<PropertyKey, unknown>)[PERF_TELEMETRY_KEY];
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<TelemetryRegistry>;
	return candidate.version === 1 && typeof candidate.acquireReporter === "function" &&
		typeof candidate.snapshot === "function" && typeof candidate.reset === "function" &&
		typeof candidate.getStatus === "function"
		? candidate as TelemetryRegistry
		: undefined;
}

function localName(name: string): string {
	return name.startsWith("cc-style.") ? name.slice("cc-style.".length) : name;
}

export class CcStyleObservability {
	private reporter: TelemetryReporter | undefined;
	private release: (() => void) | undefined;
	private enabled = false;
	private logEnabled = false;
	private window = 512;
	private slowSampleMs = 50;
	private pressureReadAt = -Infinity;
	private pressureCache = { renderMs: 0, eventLoopDelayMs: 0 };

	configure(options: { enabled: boolean; logEnabled: boolean; sampleWindow: number; slowSampleMs: number }): void {
		this.window = Math.max(16, options.sampleWindow);
		this.slowSampleMs = Math.max(1, options.slowSampleMs);
		this.logEnabled = options.logEnabled;
		this.setEnabled(options.enabled);
		this.configureReporter();
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.release?.();
			this.release = undefined;
			this.reporter = undefined;
			return;
		}
		this.connect();
	}

	setLogEnabled(enabled: boolean): void {
		this.logEnabled = enabled;
		this.configureReporter();
	}

	record(name: string, ms: number, detail?: string): void {
		if (!this.enabled || !Number.isFinite(ms)) return;
		this.connect()?.measure(localName(name), ms, detail ? { detail } : undefined);
	}

	increment(name: string, delta = 1): void {
		if (!this.enabled || !Number.isFinite(delta) || delta === 0) return;
		this.connect()?.increment(localName(name), delta);
	}

	observe(name: string, value: number, unit: string): void {
		if (!this.enabled || !Number.isFinite(value)) return;
		this.connect()?.observe(localName(name), value, unit);
	}

	gauge(name: string, value: number, unit: string): void {
		if (!this.enabled || !Number.isFinite(value)) return;
		this.connect()?.gauge(localName(name), value, unit);
	}

	measure<T>(name: string, action: () => T, detail?: string): T {
		const reporter = this.enabled ? this.connect() : undefined;
		if (!reporter) return action();
		const started = performance.now();
		try {
			return action();
		} finally {
			reporter.measure(localName(name), performance.now() - started, detail ? { detail } : undefined);
		}
	}

	/** Bounded, cached feedback for adaptive visual scheduling; no polling timer. */
	pressureSnapshot(now = performance.now()): { renderMs: number; eventLoopDelayMs: number } {
		if (now - this.pressureReadAt < 250) return this.pressureCache;
		this.pressureReadAt = now;
		const snapshot = sharedUiRegistry()?.snapshot();
		this.pressureCache = {
			renderMs: snapshot?.metrics.find(({ name }) => name === "render")?.lastMs ?? 0,
			eventLoopDelayMs: snapshot?.runtime?.eventLoopDelayP95Ms ?? 0,
		};
		return this.pressureCache;
	}

	async measureAsync<T>(name: string, action: () => Promise<T>, detail?: string): Promise<T> {
		const reporter = this.enabled ? this.connect() : undefined;
		if (!reporter) return action();
		const started = performance.now();
		try {
			return await action();
		} finally {
			reporter.measure(localName(name), performance.now() - started, detail ? { detail } : undefined);
		}
	}

	reset(): void {
		sharedTelemetryRegistry()?.reset(OWNER);
	}

	report(): string {
		this.connect();
		const uiRegistry = sharedUiRegistry();
		const telemetryRegistry = sharedTelemetryRegistry();
		const uiStatus = uiRegistry?.getStatus();
		const shared = uiRegistry?.snapshot();
		const telemetry = telemetryRegistry?.snapshot(OWNER);
		const telemetryStatus = telemetryRegistry?.getStatus();
		const runtime = shared?.runtime;
		const presentationCounters = (telemetry?.counters ?? []).filter(({ name }) => name.startsWith("presentation."));
		const pluginCounters = (telemetry?.counters ?? []).filter(({ name }) => !name.startsWith("presentation."));
		return [
			"Instrumentation health",
			uiStatus
				? `provider ${uiStatus.provider} ${uiStatus.enabled ? "on" : "off"} · frame ${uiStatus.doRender ? "ok" : "unavailable"} · request ${uiStatus.requestRender ? "ok" : "unavailable"} · telemetry ${telemetryStatus?.enabled ? "connected" : "off"}`
				: "shared metrics unavailable (pi-perf provider not loaded)",
			"",
			"Interaction latency",
			formatRows(shared?.metrics ?? []),
			"",
			"Plugin spans",
			formatRows(telemetry?.measures ?? []),
			"",
			"Streaming display",
			formatObservations(telemetry?.observations ?? [], telemetry?.gauges ?? []),
			"",
			"Presentation adapters",
			formatCounters(presentationCounters),
			"",
			"Plugin counters",
			formatCounters(pluginCounters),
			"",
			"Runtime",
			[
				`producer ${this.enabled ? "on" : "off"} · centralized slow log ${this.logEnabled ? "on" : "off"} · sample window ${this.window}`,
				runtime
					? `event loop ${(runtime.eventLoopUtilization * 100).toFixed(1)}%${runtime.eventLoopDelayP95Ms === undefined ? "" : ` · delay p95 ${runtime.eventLoopDelayP95Ms.toFixed(1)}ms`} · RSS ${megabytes(runtime.rssBytes)} · heap ${megabytes(runtime.heapUsedBytes)}`
					: "provider runtime unavailable",
			].join("\n"),
		].join("\n");
	}

	async dispose(): Promise<void> {
		this.release?.();
		this.release = undefined;
		this.reporter = undefined;
		this.enabled = false;
		this.pressureReadAt = -Infinity;
		this.pressureCache = { renderMs: 0, eventLoopDelayMs: 0 };
	}

	private connect(): TelemetryReporter | undefined {
		if (!this.enabled) return undefined;
		if (this.reporter) return this.reporter;
		const registry = sharedTelemetryRegistry();
		if (!registry) return undefined;
		const handle = registry.acquireReporter(OWNER);
		this.reporter = handle.reporter;
		this.release = handle.release;
		this.configureReporter();
		return this.reporter;
	}

	private configureReporter(): void {
		this.reporter?.configure({
			sampleWindow: this.window,
			slowSampleMs: this.slowSampleMs,
			logEnabled: this.logEnabled,
		});
	}
}

function formatCounters(rows: TelemetryCounter[]): string {
	return rows.length === 0
		? "no samples"
		: rows.map(({ name, value }) => `${name}  n=${value}`).join("\n");
}

function formatObservations(rows: TelemetryObservation[], gauges: TelemetryGauge[]): string {
	const observed = rows.map((row) =>
		`${row.name}  n=${row.count} last=${row.last.toFixed(1)}${row.unit} p50=${row.p50.toFixed(1)}${row.unit} p95=${row.p95.toFixed(1)}${row.unit} max=${row.max.toFixed(1)}${row.unit}`
	);
	const current = gauges.map((gauge) =>
		`${gauge.name}  current=${gauge.value.toFixed(1)}${gauge.unit} peak=${gauge.peak.toFixed(1)}${gauge.unit}`
	);
	return [...observed, ...current].join("\n") || "no samples";
}

function formatRows(rows: MetricStats[]): string {
	if (rows.length === 0) return "no samples";
	return rows.map((row) =>
		`${row.name}  n=${row.count} last=${row.lastMs.toFixed(1)}ms p50=${row.p50Ms.toFixed(1)}ms p95=${row.p95Ms.toFixed(1)}ms max=${row.maxMs.toFixed(1)}ms`
	).join("\n");
}
