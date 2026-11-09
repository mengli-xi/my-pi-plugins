import assert from "node:assert/strict";
import test from "node:test";
import { CcStyleObservability } from "../src/observability.ts";

const UI_KEY = Symbol.for("pi.perf.ui-metrics.v3");
const TELEMETRY_KEY = Symbol.for("pi.perf.telemetry.v1");

function fakeUiRegistry() {
	return {
		version: 3 as const,
		getStatus: () => ({
			requestRender: true,
			doRender: true,
			handleTerminalInput: true,
			provider: "pi-perf",
			enabled: true,
			subscribers: 1,
		}),
		snapshot: () => ({ at: Date.now(), metrics: [], owners: ["pi-perf"] }),
	};
}

function fakeTelemetryRegistry() {
	const owners = new Set<string>();
	const configs = new Map<string, Record<string, unknown>>();
	const measures: Array<{ owner: string; name: string; value: number; attributes?: Record<string, unknown> }> = [];
	const observations: Array<{ owner: string; name: string; value: number; unit: string }> = [];
	const counters = new Map<string, number>();
	const gauges = new Map<string, { owner: string; name: string; value: number; peak: number; unit: string }>();
	const resets: string[] = [];
	return {
		version: 1 as const,
		acquireReporter(owner: string) {
			owners.add(owner);
			let active = true;
			return {
				reporter: {
					configure(config: Record<string, unknown>) { configs.set(owner, { ...config }); },
					measure(name: string, value: number, attributes?: Record<string, unknown>) { if (active) measures.push({ owner, name, value, attributes }); },
					increment(name: string, delta = 1) { if (active) counters.set(`${owner}\0${name}`, (counters.get(`${owner}\0${name}`) ?? 0) + delta); },
					observe(name: string, value: number, unit: string) { if (active) observations.push({ owner, name, value, unit }); },
					gauge(name: string, value: number, unit: string) {
						if (!active) return;
						const key = `${owner}\0${name}`;
						const previous = gauges.get(key);
						gauges.set(key, { owner, name, value, peak: Math.max(previous?.peak ?? value, value), unit });
					},
				},
				release() { if (active) { active = false; owners.delete(owner); } },
			};
		},
		snapshot(owner?: string) {
			const selectedMeasures = measures.filter((row) => owner === undefined || row.owner === owner).map((row) => ({
				owner: row.owner, name: row.name, count: 1, lastMs: row.value, p50Ms: row.value, p95Ms: row.value, maxMs: row.value,
			}));
			return {
				at: Date.now(),
				owners: [...owners].filter((value) => owner === undefined || value === owner),
				measures: selectedMeasures,
				observations: observations.filter((row) => owner === undefined || row.owner === owner).map((row) => ({
					owner: row.owner, name: row.name, unit: row.unit, count: 1, last: row.value, p50: row.value, p95: row.value, max: row.value,
				})),
				counters: [...counters].flatMap(([key, value]) => {
					const [rowOwner, name] = key.split("\0");
					return owner === undefined || rowOwner === owner ? [{ owner: rowOwner!, name: name!, value }] : [];
				}),
				gauges: [...gauges.values()].filter((row) => owner === undefined || row.owner === owner),
			};
		},
		reset(owner: string) {
			resets.push(owner);
			for (let index = measures.length - 1; index >= 0; index--) if (measures[index]?.owner === owner) measures.splice(index, 1);
		},
		getStatus: () => ({ provider: "pi-perf", enabled: true, producers: owners.size, observers: 1 }),
		owners,
		configs,
		measures,
		resets,
	};
}

async function withGlobals(run: (telemetry: ReturnType<typeof fakeTelemetryRegistry>) => Promise<void> | void) {
	const host = globalThis as Record<PropertyKey, unknown>;
	const previousUi = host[UI_KEY];
	const previousTelemetry = host[TELEMETRY_KEY];
	const telemetry = fakeTelemetryRegistry();
	host[UI_KEY] = fakeUiRegistry();
	host[TELEMETRY_KEY] = telemetry;
	try {
		await run(telemetry);
	} finally {
		if (previousUi === undefined) delete host[UI_KEY]; else host[UI_KEY] = previousUi;
		if (previousTelemetry === undefined) delete host[TELEMETRY_KEY]; else host[TELEMETRY_KEY] = previousTelemetry;
	}
}

test("producer retries when pi-perf loads after cc-style", async () => {
	const host = globalThis as Record<PropertyKey, unknown>;
	const previousUi = host[UI_KEY];
	const previousTelemetry = host[TELEMETRY_KEY];
	delete host[UI_KEY];
	delete host[TELEMETRY_KEY];
	const perf = new CcStyleObservability();
	try {
		perf.configure({ enabled: true, logEnabled: false, sampleWindow: 64, slowSampleMs: 50 });
		assert.match(perf.report(), /provider not loaded/);
		const telemetry = fakeTelemetryRegistry();
		host[UI_KEY] = fakeUiRegistry();
		host[TELEMETRY_KEY] = telemetry;
		assert.match(perf.report(), /provider pi-perf on/);
		assert.deepEqual([...telemetry.owners], ["pi-claude-style"]);
		await perf.dispose();
		assert.equal(telemetry.owners.size, 0);
	} finally {
		await perf.dispose();
		if (previousUi === undefined) delete host[UI_KEY]; else host[UI_KEY] = previousUi;
		if (previousTelemetry === undefined) delete host[TELEMETRY_KEY]; else host[TELEMETRY_KEY] = previousTelemetry;
	}
});

test("producer reset clears only cc-style telemetry", async () => withGlobals(async (telemetry) => {
	const perf = new CcStyleObservability();
	try {
		perf.configure({ enabled: true, logEnabled: false, sampleWindow: 16, slowSampleMs: 50 });
		perf.record("local", 2);
		perf.reset();
		assert.deepEqual(telemetry.resets, ["pi-claude-style"]);
		assert.match(perf.report(), /Plugin spans\nno samples/);
	} finally { await perf.dispose(); }
}));

test("producer acquires and releases the centralized reporter", async () => withGlobals(async (telemetry) => {
	const perf = new CcStyleObservability();
	perf.configure({ enabled: true, logEnabled: false, sampleWindow: 64, slowSampleMs: 50 });
	assert.deepEqual([...telemetry.owners], ["pi-claude-style"]);
	perf.setEnabled(false);
	assert.equal(telemetry.owners.size, 0);
	await perf.dispose();
}));

test("forwards log policy and bounded metadata to the provider", async () => withGlobals(async (telemetry) => {
	const perf = new CcStyleObservability();
	try {
		perf.configure({ enabled: true, logEnabled: true, sampleWindow: 16, slowSampleMs: 1 });
		perf.record("cc-style.test", 3, "bounded-enum");
		assert.deepEqual(telemetry.configs.get("pi-claude-style"), { sampleWindow: 16, slowSampleMs: 1, logEnabled: true });
		assert.deepEqual(telemetry.measures[0], {
			owner: "pi-claude-style", name: "test", value: 3, attributes: { detail: "bounded-enum" },
		});
	} finally { await perf.dispose(); }
}));

test("reports centralized streaming distributions and gauges", async () => withGlobals(async () => {
	const perf = new CcStyleObservability();
	try {
		perf.configure({ enabled: true, logEnabled: false, sampleWindow: 16, slowSampleMs: 50 });
		perf.observe("cc-style.typewriter.batch", 12, "chars");
		perf.gauge("cc-style.typewriter.backlog-current", 20, "chars");
		perf.gauge("cc-style.typewriter.backlog-current", 5, "chars");
		const report = perf.report();
		assert.match(report, /Streaming display/);
		assert.match(report, /typewriter\.batch  n=1 last=12\.0chars/);
		assert.match(report, /backlog-current  current=5\.0chars peak=20\.0chars/);
	} finally { await perf.dispose(); }
}));

test("reports centralized presentation spans and counters separately", async () => withGlobals(async () => {
	const perf = new CcStyleObservability();
	try {
		perf.configure({ enabled: true, logEnabled: false, sampleWindow: 16, slowSampleMs: 50 });
		perf.measure("cc-style.presentation.resolve", () => undefined);
		perf.increment("cc-style.presentation.resolve.cache-hit");
		perf.increment("cc-style.presentation.adapter.process.group.hit");
		const report = perf.report();
		assert.match(report, /Plugin spans[\s\S]*presentation\.resolve/);
		assert.match(report, /Presentation adapters/);
		assert.match(report, /presentation\.resolve\.cache-hit  n=1/);
		assert.match(report, /presentation\.adapter\.process\.group\.hit  n=1/);
	} finally { await perf.dispose(); }
}));
