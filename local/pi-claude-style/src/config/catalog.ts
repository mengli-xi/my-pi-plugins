import { DEFAULT_EFFECTIVE_CONFIG } from "./defaults.ts";

export type ApplyMode = "live" | "reload" | "restart";

export interface ConfigDescriptor<T = unknown> {
	path: string;
	description: string;
	defaultValue: T;
	/** Finite public values, derived from the same defaults/enum table as validation. */
	choices?: readonly (string | boolean)[];
	apply: ApplyMode;
	owner: string;
	validate(value: unknown): T;
}

const RESTART_PATHS = new Set<string>();

const LIVE_PATHS = new Set([
	"performance.enabled",
	"performance.logEnabled",
]);

export const NUMBER_RANGES: Readonly<Record<string, readonly [number, number]>> = {
	"performance.sampleWindow": [16, 10_000],
	"performance.slowSampleMs": [1, 60_000],
	"working.showCancelHintAfterMs": [0, 600_000],
	"working.refreshMs": [75, 2_000],
	"working.spinnerIntervalMs": [80, 2_000],
	"working.verbRotateMs": [1_000, 120_000],
	"working.messageWidth": [40, 300],
	"transcript.maxGroups": [10, 1_000],
	"transcript.maxResultChars": [1_000, 2_000_000],
	"transcript.maxCapturedBytes": [100_000, 1_000_000_000],
	"transcript.overlay.mouseScrollLines": [1, 20],
	"transcript.diff.addedBg": [0, 255],
	"transcript.diff.removedBg": [0, 255],
	"transcript.diff.addedHighlightBg": [0, 255],
	"transcript.diff.removedHighlightBg": [0, 255],
	"transcript.userMessages.horizontalPadding": [0, 4],
	"transcript.userMessages.verticalPadding": [0, 3],
	"transcript.userMessages.topMargin": [0, 3],
	"transcript.userMessages.maxLines": [0, 200],
	"transcript.assistantMessages.typewriter.frameMs": [16, 1_000],
	"transcript.assistantMessages.typewriter.renderBudgetMs": [1, 100],
	"transcript.assistantMessages.typewriter.maxFrameMs": [16, 2_000],
	"transcript.assistantMessages.typewriter.minCharsPerFrame": [1, 1_000],
	"transcript.assistantMessages.typewriter.maxCharsPerFrame": [1, 10_000],
	"transcript.assistantMessages.typewriter.targetLagMs": [16, 10_000],
	"transcript.assistantMessages.typewriter.finalDrainMs": [0, 30_000],
	"transcript.goal.refreshMs": [250, 10_000],
	"transcript.goal.completedLingerMs": [0, 120_000],
	"transcript.nativeToolOutput.maxLines": [2, 20],
	"loading.idleDelayMs": [0, 5_000],
	"layout.popupGap": [0, 100],
	"layout.minViewportRows": [1, 1_000],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
	"transcript.expandMode": ["inline", "overlay"],
	"transcript.importantTools.webDetails": ["overlay"],
	"transcript.userMessages.style": ["native", "compact-box"],
	"transcript.assistantMessages.style": ["native", "claude"],
	"transcript.assistantMessages.markerColor": ["accent", "text", "muted"],
	"transcript.assistantMessages.collapsedThinking": ["activity", "preview", "label"],
	"transcript.goal.placement": ["aboveEditor", "belowEditor", "statusline"],
	"transcript.customMessages.style": ["native", "claude"],
	"working.style": ["plain", "cyber"],
	"loading.mode": ["balanced", "eager", "minimal"],
};

function owner(path: string): string {
	return path.split(".")[0] ?? "cc-style";
}

function describe(path: string): string {
	const range = NUMBER_RANGES[path];
	return `Configure ${path}${range ? ` (integer ${range[0]}..${range[1]})` : ""}`;
}

function validateFor(path: string, fallback: unknown): (value: unknown) => unknown {
	if (typeof fallback === "boolean") return (value) => {
		if (typeof value !== "boolean") throw new TypeError(`${path} expects boolean`);
		return value;
	};
	if (typeof fallback === "number") return (value) => {
		if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${path} expects an integer`);
		const range = NUMBER_RANGES[path];
		if (!range) throw new Error(`${path} has no declared numeric range`);
		if (value < range[0] || value > range[1]) {
			throw new RangeError(`${path} expects ${range[0]}..${range[1]}`);
		}
		return value;
	};
	if (typeof fallback === "string") return (value) => {
		if (typeof value !== "string") throw new TypeError(`${path} expects string`);
		const allowed = ENUM_VALUES[path];
		if (allowed && !allowed.includes(value)) throw new RangeError(`${path} expects one of ${allowed.join(", ")}`);
		if (!allowed && value.trim().length === 0) throw new RangeError(`${path} expects a non-empty string`);
		return value;
	};
	if (Array.isArray(fallback)) return (value) => {
		if (!Array.isArray(value)) throw new TypeError(`${path} expects a JSON array`);
		return structuredClone(value);
	};
	return (value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeError(`${path} expects a JSON object`);
		}
		return structuredClone(value);
	};
}

function flatten(value: unknown, prefix = ""): ConfigDescriptor[] {
	if (Array.isArray(value) || value === null || typeof value !== "object") {
		return [{
			path: prefix,
			description: describe(prefix),
			defaultValue: structuredClone(value),
			...(typeof value === "boolean" ? { choices: [true, false] } : ENUM_VALUES[prefix] ? { choices: ENUM_VALUES[prefix] } : {}),
			apply: LIVE_PATHS.has(prefix) ? "live" : RESTART_PATHS.has(prefix) ? "restart" : "reload",
			owner: owner(prefix),
			validate: validateFor(prefix, value),
		}];
	}
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
		flatten(child, prefix ? `${prefix}.${key}` : key)
	);
}

export const CONFIG_CATALOG: readonly ConfigDescriptor[] = flatten(DEFAULT_EFFECTIVE_CONFIG);

const BY_PATH = new Map(CONFIG_CATALOG.map((entry) => [entry.path, entry]));

export function descriptorFor(path: string): ConfigDescriptor | undefined {
	return BY_PATH.get(path);
}
