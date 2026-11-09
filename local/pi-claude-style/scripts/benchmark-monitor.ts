import { performance } from "node:perf_hooks";
import { CcStyleObservability } from "../src/observability.ts";

const RUNS = Math.max(30, Number(process.env.CC_STYLE_BENCH_RUNS ?? 45));
const REPEATS = Math.max(1, Number(process.env.CC_STYLE_BENCH_REPEATS ?? 36));
const BOOTSTRAPS = 2_000;
let sink = 0;

function fixture(): number {
	let checksum = 0;
	for (let repeat = 0; repeat < REPEATS; repeat++) {
		const rows: string[] = [];
		for (let index = 0; index < 1_200; index++) {
			const kind = index % 7 === 0 ? "tool" : index % 3 === 0 ? "assistant" : "text";
			rows.push(`${kind}:${index}:${(index * 2_654_435_761) >>> 0}`.padEnd(72, "·"));
		}
		const visible = rows.slice(-160).map((row, index) => `${String(index).padStart(3)} ${row}`).join("\n");
		checksum ^= visible.length + visible.charCodeAt((repeat * 97) % visible.length);
	}
	return checksum;
}

function timed(action: () => void): number {
	const started = performance.now();
	action();
	return performance.now() - started;
}

function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)] ?? 0;
}

function samples(perf: CcStyleObservability, enabled: boolean): number[] {
	perf.setEnabled(enabled);
	const values: number[] = [];
	for (let index = 0; index < RUNS; index++) {
		values.push(timed(() => {
			sink ^= enabled
				? perf.measure("benchmark.fixture", fixture)
				: fixture();
		}));
	}
	return values;
}

function rng(seed = 0x5eed1234): () => number {
	let value = seed >>> 0;
	return () => {
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		return (value >>> 0) / 0x1_0000_0000;
	};
}

function bootstrapP95Regression(baseline: readonly number[], enabled: readonly number[]): [number, number] {
	const random = rng();
	const results: number[] = [];
	for (let iteration = 0; iteration < BOOTSTRAPS; iteration++) {
		const base: number[] = [];
		const on: number[] = [];
		for (let index = 0; index < enabled.length; index++) {
			base.push(baseline[Math.floor(random() * baseline.length)] ?? 0);
			on.push(enabled[Math.floor(random() * enabled.length)] ?? 0);
		}
		results.push((percentile(on, 95) / percentile(base, 95) - 1) * 100);
	}
	return [percentile(results, 2.5), percentile(results, 97.5)];
}

const perf = new CcStyleObservability();
perf.configure({ enabled: false, logEnabled: false, sampleWindow: RUNS * 2, slowSampleMs: 60_000 });
for (let index = 0; index < 8; index++) sink ^= fixture();

const offBefore = samples(perf, false);
const on = samples(perf, true);
const offAfter = samples(perf, false);
await perf.dispose();

const baseline = [...offBefore, ...offAfter];
const baselineP95 = percentile(baseline, 95);
const enabledP95 = percentile(on, 95);
const regression = (enabledP95 / baselineP95 - 1) * 100;
const confidence95 = bootstrapP95Regression(baseline, on);
const verdict = confidence95[1] <= 1 ? "pass" : confidence95[0] > 1 ? "fail" : "inconclusive";

console.log(JSON.stringify({
	scope: "CcStyleObservability local measure bookkeeping only",
	providerInstalled: false,
	note: "This harness does not install pi-perf or exercise a TUI frame; it is not an end-to-end monitoring regression result.",
	runtime: process.version,
	runsPerSegment: RUNS,
	repeatsPerFixture: REPEATS,
	order: ["off", "on", "off"],
	medianMs: {
		offBefore: percentile(offBefore, 50),
		on: percentile(on, 50),
		offAfter: percentile(offAfter, 50),
	},
	p95Ms: { baseline: baselineP95, on: enabledP95 },
	maxMs: { baseline: Math.max(...baseline), on: Math.max(...on) },
	p95RegressionPercent: regression,
	confidence95Percent: confidence95,
	thresholdPercent: 1,
	localBookkeepingVerdict: verdict,
	checksum: sink,
}, null, 2));

// Informational only. The real 1% acceptance gate belongs to the Bun+TTY
// off/on/off harness described in the architecture plan.
