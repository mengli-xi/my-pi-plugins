import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LegacyMigrationReceipt {
	at: string;
	sources: Array<{ path: string; sha256: string }>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let current = target;
	for (const part of parts.slice(0, -1)) {
		if (!record(current[part])) current[part] = {};
		current = current[part] as Record<string, unknown>;
	}
	current[parts.at(-1)!] = structuredClone(value);
}

function digest(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

export function migrateLegacyConfig(
	agentDir: string,
	now: Date,
): { overrides: Record<string, unknown>; migration?: LegacyMigrationReceipt } {
	const overrides: Record<string, unknown> = {};
	const sources: LegacyMigrationReceipt["sources"] = [];
	const transcriptPath = join(agentDir, "extensions", "pi-claude-transcript", "config.json");
	if (existsSync(transcriptPath)) {
		try {
			const raw = readFileSync(transcriptPath, "utf8");
			const legacy = JSON.parse(raw) as unknown;
			if (record(legacy)) {
				if (typeof legacy.enabled === "boolean") setPath(overrides, "features.transcript", legacy.enabled);
				if (record(legacy.working)) {
					if (typeof legacy.working.enabled === "boolean") {
						setPath(overrides, "features.working", legacy.working.enabled);
					}
					const working = { ...legacy.working };
					delete working.enabled;
					if (Object.keys(working).length > 0) setPath(overrides, "working", working);
				}
				const transcript = { ...legacy };
				delete transcript.enabled;
				delete transcript.working;
				delete transcript.integrations;
				setPath(overrides, "transcript", transcript);
				sources.push({ path: transcriptPath, sha256: digest(raw) });
			}
		} catch {
			// Invalid legacy files remain untouched and are not migration sources.
		}
	}
	return {
		overrides,
		...(sources.length > 0 ? { migration: { at: now.toISOString(), sources } } : {}),
	};
}

/** The retired pi-pinned-layout settings that still mean something in Pi fullscreen. */
const PINNED_LAYOUT_KEYS = ["enabled", "stickyUserMessage", "floatAutocomplete", "popupGap", "minViewportRows"] as const;

export interface PinnedLayoutImport {
	/** `layout.*` values for CC's store, as Pinned had them. */
	values: Record<string, unknown>;
	source: { path: string; sha256: string };
}

/**
 * Read the retired pi-pinned-layout configuration: its own store first
 * (`extensions/pi-pinned-layout/config.json`, `{ overrides }`), then the plain
 * legacy file `pi-pinned-layout.json`. Only the fullscreen keys carry over;
 * the regular-mode ones (align, pinStatus, mouse, lineStep, …) are dropped.
 * The source is never modified.
 */
export function importRetiredPinnedLayout(agentDir: string): PinnedLayoutImport | undefined {
	const candidates = [
		join(agentDir, "extensions", "pi-pinned-layout", "config.json"),
		join(agentDir, "pi-pinned-layout.json"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			const source = record(parsed) && record(parsed.overrides) ? parsed.overrides : parsed;
			if (!record(source)) continue;
			const values: Record<string, unknown> = {};
			for (const key of PINNED_LAYOUT_KEYS) {
				if (source[key] !== undefined) values[`layout.${key}`] = structuredClone(source[key]);
			}
			return { values, source: { path, sha256: digest(raw) } };
		} catch {
			// An unreadable file is left alone and not a migration source.
		}
	}
	return undefined;
}
