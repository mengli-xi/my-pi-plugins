import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type Conf from "conf";
import { CONFIG_CATALOG, descriptorFor, type ConfigDescriptor } from "./catalog.ts";
import { DEFAULT_EFFECTIVE_CONFIG, type EffectiveCcStyleConfig } from "./defaults.ts";
import { getAgentDir } from "./agent-dir.ts";
import { importRetiredPinnedLayout, migrateLegacyConfig, type PinnedLayoutImport } from "./migrations.ts";
import { validateStoredDocument } from "./schema.ts";

export type DeepPartial<T> = T extends readonly unknown[] ? T
	: T extends object ? { [K in keyof T]?: DeepPartial<T[K]> }
	: T;

export interface MigrationReceipt {
	at: string;
	sources: Array<{ path: string; sha256: string }>;
}

export interface StoredCcStyleConfig {
	schemaVersion: 6;
	revision: number;
	overrides: DeepPartial<EffectiveCcStyleConfig> & Record<string, unknown>;
	migration?: MigrationReceipt;
}

export interface ConfigValueStatus {
	path: string;
	active: unknown;
	stored: unknown;
	pending: unknown;
	source: "env" | "user" | "default";
	apply: ConfigDescriptor["apply"];
}

export interface ConfigMutation extends ConfigValueStatus {
	old: unknown;
	next: unknown;
	revision: number;
}

const ENV_VALUES: Record<string, string> = {
	"performance.enabled": "PI_CC_STYLE_PERF",
};

// Keep the synchronous mutation API and Conf's atomic writer, without loading
// its validator/dependency graph when an already validated v6 store is only read.
const requireConfigStorage = createRequire(import.meta.url);
// Build-only path to the dormant, self-contained writer. Native require in a
// compiled Bun executable cannot resolve Conf's external ESM dependency graph.
declare const CC_STYLE_CONFIG_STORAGE_MODULE: string | undefined;

function createConfigStorage(cwd: string): Conf<StoredCcStyleConfig> {
	// Source-loaded tests use Node ESM or jiti's contextual require. Bundles load
	// the writer sidecar synchronously, only after validation requires a write.
	const { default: Conf } = (typeof CC_STYLE_CONFIG_STORAGE_MODULE === "undefined"
		? (typeof require === "function" ? require("conf") : requireConfigStorage("conf"))
		: requireConfigStorage(CC_STYLE_CONFIG_STORAGE_MODULE)) as typeof import("conf");
	return new Conf<StoredCcStyleConfig>({ cwd, configName: "config", clearInvalidConfig: false });
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		if (!record(current)) return undefined;
		current = current[part];
	}
	return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let current = target;
	for (const part of parts.slice(0, -1)) {
		const next = current[part];
		if (!record(next)) current[part] = {};
		current = current[part] as Record<string, unknown>;
	}
	current[parts.at(-1)!] = structuredClone(value);
}

function deletePath(target: Record<string, unknown>, path: string): void {
	const parts = path.split(".");
	const parents: Array<[Record<string, unknown>, string]> = [];
	let current = target;
	for (const part of parts.slice(0, -1)) {
		const next = current[part];
		if (!record(next)) return;
		parents.push([current, part]);
		current = next;
	}
	delete current[parts.at(-1)!];
	for (const [parent, key] of parents.reverse()) {
		if (record(parent[key]) && Object.keys(parent[key] as object).length === 0) delete parent[key];
	}
}

function migrateLegacyDiffHighlight(overrides: Record<string, unknown>): boolean {
	const legacy = getPath(overrides, "transcript.diff.highlightBg");
	if (legacy === undefined) return false;
	if (getPath(overrides, "transcript.diff.addedHighlightBg") === undefined) {
		setPath(overrides, "transcript.diff.addedHighlightBg", legacy);
	}
	if (getPath(overrides, "transcript.diff.removedHighlightBg") === undefined) {
		setPath(overrides, "transcript.diff.removedHighlightBg", legacy);
	}
	deletePath(overrides, "transcript.diff.highlightBg");
	return true;
}

function merge<T>(base: T, overrides: unknown): T {
	if (!record(base) || !record(overrides)) return structuredClone(overrides) as T;
	const result = structuredClone(base) as Record<string, unknown>;
	for (const [key, value] of Object.entries(overrides)) {
		result[key] = record(value) && record(result[key]) ? merge(result[key], value) : structuredClone(value);
	}
	return result as T;
}

function envBoolean(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	if (["1", "true", "on"].includes(raw.trim().toLowerCase())) return true;
	if (["0", "false", "off"].includes(raw.trim().toLowerCase())) return false;
	return undefined;
}

/**
 * Put the retired Pinned Layout's fullscreen settings into `layout.*`, keeping
 * any value CC already has. Invalid values are skipped rather than failing
 * the whole store. Returns the receipt with the source appended.
 */
function applyPinnedImport(
	overrides: Record<string, unknown>,
	pinned: PinnedLayoutImport | undefined,
	receipt: MigrationReceipt | undefined,
	now: Date,
): MigrationReceipt | undefined {
	if (!pinned) return receipt;
	for (const [path, value] of Object.entries(pinned.values)) {
		if (getPath(overrides, path) !== undefined) continue;
		try { descriptorFor(path)?.validate(value); }
		catch { continue; }
		setPath(overrides, path, value);
	}
	return {
		at: receipt?.at ?? now.toISOString(),
		sources: [...(receipt?.sources ?? []), pinned.source],
	};
}

function parseStore(raw: string, importPinned: () => PinnedLayoutImport | undefined = () => undefined, now = new Date()): {
	document: StoredCcStyleConfig;
	migrated: boolean;
	sourceVersion: 1 | 2 | 3 | 4 | 5 | 6;
	backupSuffix: string;
	pinned?: PinnedLayoutImport;
} {
	const parsed = validateStoredDocument(JSON.parse(raw));
	const schemaMigrated = parsed.schemaVersion !== 6;
	const originalVersion = parsed.schemaVersion;
	const overrides = structuredClone(parsed.overrides);
	if (originalVersion === 1) {
		// v2 retires the hosted extension control plane. Drop only those two
		// paths; every unrelated user override and the legacy import receipt stay
		// byte-for-byte equivalent after the one-time rewrite.
		deletePath(overrides, "features.integrations");
		deletePath(overrides, "integrations");
	}
	if (schemaMigrated) {
		deletePath(overrides, "transcript.sessionNaming");
		const legacyWorkingEnabled = getPath(overrides, "working.enabled");
		if (typeof legacyWorkingEnabled === "boolean" && getPath(overrides, "features.working") === undefined) {
			setPath(overrides, "features.working", legacyWorkingEnabled);
		}
		deletePath(overrides, "working.enabled");
		if (originalVersion <= 3) {
			// v4 transferred layout ownership to pi-pinned-layout, whose store
			// imported these values (the exact v3 backup stayed a fallback source).
			deletePath(overrides, "features.layout");
			deletePath(overrides, "layout");
		}
		// Slice 7 replaces the temporary installer-engine flag. Preserve an
		// explicit eager choice; map the removed direct-installer rollback to
		// the new eager timing, while an absent old default adopts balanced.
		if (getPath(overrides, "loading.mode") === "legacy") {
			setPath(overrides, "loading.mode", "eager");
		}
	}
	// v6 takes the fullscreen adaptations back from the retired Pinned Layout.
	const pinned = originalVersion < 6 ? importPinned() : undefined;
	const receipt = applyPinnedImport(
		overrides,
		pinned,
		parsed.migration ? structuredClone(parsed.migration) as MigrationReceipt : undefined,
		now,
	);
	const diffHighlightMigrated = migrateLegacyDiffHighlight(overrides);
	const migrated = schemaMigrated || diffHighlightMigrated;
	const document: StoredCcStyleConfig = {
		schemaVersion: 6,
		revision: parsed.revision + (migrated ? 1 : 0),
		overrides: overrides as StoredCcStyleConfig["overrides"],
		...(receipt ? { migration: receipt } : {}),
	};
	for (const descriptor of CONFIG_CATALOG) {
		const value = getPath(document.overrides, descriptor.path);
		if (value === undefined) continue;
		try { descriptor.validate(value); }
		catch (error) {
			throw new Error(`invalid ${descriptor.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		document,
		migrated,
		sourceVersion: originalVersion,
		backupSuffix: schemaMigrated
			? `.schema-v${originalVersion}.bak`
			: ".shared-diff-highlight.bak",
		...(pinned ? { pinned } : {}),
	};
}

/** Keep the retired Pinned file's exact bytes beside it; the original is never touched. */
function backupPinnedSource(pinned: PinnedLayoutImport): void {
	const backup = `${pinned.source.path}.cc-style-v6.bak`;
	// A failed backup keeps the store read-only; never persist an unbacked import.
	if (!existsSync(backup)) copyFileSync(pinned.source.path, backup);
}

function sanitizeMigratedOverrides(overrides: StoredCcStyleConfig["overrides"]): StoredCcStyleConfig["overrides"] {
	const sanitized = structuredClone(overrides) as Record<string, unknown>;
	migrateLegacyDiffHighlight(sanitized);
	for (const descriptor of CONFIG_CATALOG) {
		const value = getPath(sanitized, descriptor.path);
		if (value === undefined) continue;
		try { descriptor.validate(value); }
		catch { deletePath(sanitized, descriptor.path); }
	}
	return sanitized as StoredCcStyleConfig["overrides"];
}

export interface ConfigServiceOptions {
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	/** Child presentation runtimes may read the active document but never migrate or write it. */
	readOnly?: boolean;
}

export class ConfigService {
	readonly path: string;
	readonly catalog = CONFIG_CATALOG;
	degradedError: string | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => Date;
	private readonly readOnly: boolean;
	private conf: Conf<StoredCcStyleConfig> | undefined;
	private stored: StoredCcStyleConfig;
	private activeConfig: EffectiveCcStyleConfig;
	private observedMtimeMs: number | undefined;

	constructor(options: ConfigServiceOptions = {}) {
		const agentDir = options.agentDir ?? getAgentDir();
		this.env = options.env ?? process.env;
		this.now = options.now ?? (() => new Date());
		this.readOnly = options.readOnly ?? false;
		const cwd = join(agentDir, "extensions", "pi-claude-style");
		this.path = join(cwd, "config.json");
		let initial: StoredCcStyleConfig | undefined;
		let initialMigrated = false;
		let degraded: string | undefined;
		const importPinned = () => importRetiredPinnedLayout(agentDir);
		if (existsSync(this.path)) {
			try {
				const parsed = parseStore(readFileSync(this.path, "utf8"), importPinned, this.now());
				initial = parsed.document;
				initialMigrated = parsed.migrated;
				if (initialMigrated && !options.readOnly) {
					const backup = `${this.path}${parsed.backupSuffix}`;
					if (!existsSync(backup)) copyFileSync(this.path, backup);
					if (parsed.pinned) backupPinnedSource(parsed.pinned);
				}
				this.observedMtimeMs = statSync(this.path).mtimeMs;
			} catch (error) {
				degraded = error instanceof Error ? error.message : String(error);
			}
		}
		this.degradedError = degraded;
		if (degraded) {
			this.stored = { schemaVersion: 6, revision: 0, overrides: {} };
			this.activeConfig = this.compose(this.stored.overrides);
			return;
		}
		if (options.readOnly) {
			this.stored = initial ?? { schemaVersion: 6, revision: 0, overrides: {} };
			this.activeConfig = this.compose(this.stored.overrides);
			return;
		}

		try {
			mkdirSync(cwd, { recursive: true });
			const migrated: StoredCcStyleConfig = initial ?? (() => {
				const legacy = migrateLegacyConfig(agentDir, this.now());
				const overrides = sanitizeMigratedOverrides(legacy.overrides as StoredCcStyleConfig["overrides"]);
				const pinned = importPinned();
				const migration = applyPinnedImport(overrides, pinned, legacy.migration, this.now());
				if (pinned) backupPinnedSource(pinned);
				return {
					schemaVersion: 6,
					revision: 0,
					overrides,
					...(migration ? { migration } : {}),
				};
			})();
			if (!initial || initialMigrated) {
				this.conf = createConfigStorage(cwd);
				this.conf.store = migrated;
			}
			this.stored = initial ?? migrated;
			this.observedMtimeMs = existsSync(this.path) ? statSync(this.path).mtimeMs : undefined;
			this.activeConfig = this.compose(this.stored.overrides);
		} catch (error) {
			this.conf = undefined;
			this.degradedError = `store unavailable: ${error instanceof Error ? error.message : String(error)}`;
			this.stored = { schemaVersion: 6, revision: 0, overrides: {} };
			this.activeConfig = this.compose(this.stored.overrides);
		}
	}

	get revision(): number {
		return this.stored.revision;
	}

	get active(): EffectiveCcStyleConfig {
		return structuredClone(this.activeConfig);
	}

	diagnostics(): {
		degradedError?: string;
		revision: number;
		migration?: MigrationReceipt;
		unknownPaths: string[];
		pendingPaths: string[];
	} {
		const known = new Set(this.catalog.map(({ path }) => path));
		const leaves = (value: unknown, prefix = ""): string[] => {
			if (!record(value) || Array.isArray(value)) return prefix ? [prefix] : [];
			return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
		};
		return {
			...(this.degradedError ? { degradedError: this.degradedError } : {}),
			revision: this.revision,
			...(this.stored.migration ? { migration: structuredClone(this.stored.migration) } : {}),
			unknownPaths: leaves(this.stored.overrides).filter((path) => !known.has(path)),
			pendingPaths: this.list().filter(({ pending }) => pending !== undefined).map(({ path }) => path),
		};
	}

	list(prefix = ""): ConfigValueStatus[] {
		return this.catalog
			.filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}.`))
			.map((entry) => this.get(entry.path));
	}

	get(path: string): ConfigValueStatus {
		if (path.startsWith("statusline.")) throw new Error(`${path} is external settings-owned and read-only`);
		const descriptor = descriptorFor(path);
		if (!descriptor) throw new Error(`unknown config path: ${path}`);
		const stored = getPath(this.stored.overrides, path);
		const envName = ENV_VALUES[path];
		const envValue = envName ? envBoolean(this.env[envName]) : undefined;
		const effectiveStored = stored === undefined ? descriptor.defaultValue : stored;
		const next = envValue ?? effectiveStored;
		const active = getPath(this.activeConfig, path);
		return {
			path,
			active,
			stored,
			pending: isDeepStrictEqual(active, next) ? undefined : structuredClone(next),
			source: envValue !== undefined ? "env" : stored !== undefined ? "user" : "default",
			apply: descriptor.apply,
		};
	}

	set(path: string, raw: unknown, expectedRevision = this.revision): ConfigMutation {
		const descriptor = descriptorFor(path);
		if (!descriptor) throw new Error(`unknown config path: ${path}`);
		const old = this.get(path).active;
		const next = descriptor.validate(raw);
		const overrides = structuredClone(this.stored.overrides) as Record<string, unknown>;
		setPath(overrides, path, next);
		this.commit(overrides, expectedRevision);
		if (descriptor.apply === "live") {
			setPath(this.activeConfig as unknown as Record<string, unknown>, path, this.desiredValue(path, descriptor));
		}
		return { ...this.get(path), old, next, revision: this.revision };
	}

	reset(path: string, expectedRevision = this.revision): ConfigMutation {
		const descriptor = descriptorFor(path);
		if (!descriptor) throw new Error(`unknown config path: ${path}`);
		const old = this.get(path).active;
		const overrides = structuredClone(this.stored.overrides) as Record<string, unknown>;
		deletePath(overrides, path);
		this.commit(overrides, expectedRevision);
		const next = this.desiredValue(path, descriptor);
		if (descriptor.apply === "live") {
			setPath(this.activeConfig as unknown as Record<string, unknown>, path, next);
		}
		return { ...this.get(path), old, next, revision: this.revision };
	}

	resetAll(expectedRevision = this.revision): void {
		this.commit({}, expectedRevision);
		for (const descriptor of this.catalog) {
			if (descriptor.apply !== "live") continue;
			setPath(this.activeConfig as unknown as Record<string, unknown>, descriptor.path, this.desiredValue(descriptor.path, descriptor));
		}
	}

	/**
	 * Explicit recovery for a store that could not be parsed or validated.
	 * The unreadable bytes are moved aside before a fresh Conf document is
	 * created, so recovery never destroys the only forensic/rollback copy.
	 */
	recoverResetAll(): string | undefined {
		if (!this.degradedError) {
			this.resetAll();
			return undefined;
		}
		const suffix = this.now().toISOString().replace(/[:.]/g, "-");
		const backupPath = `${this.path}.invalid-${suffix}.bak`;
		if (existsSync(this.path)) renameSync(this.path, backupPath);
		const cwd = dirname(this.path);
		this.conf = createConfigStorage(cwd);
		this.stored = { schemaVersion: 6, revision: 0, overrides: {} };
		this.conf.store = this.stored;
		this.observedMtimeMs = statSync(this.path).mtimeMs;
		this.activeConfig = this.compose(this.stored.overrides);
		this.degradedError = undefined;
		return existsSync(backupPath) ? backupPath : undefined;
	}

	commit(nextOverrides: Record<string, unknown>, expectedRevision: number): void {
		if (this.readOnly || this.degradedError) throw new Error(`config is read-only: ${this.degradedError ?? "store unavailable"}`);
		if (expectedRevision !== this.stored.revision) throw new Error(`revision conflict: expected ${expectedRevision}, active ${this.stored.revision}`);
		if (existsSync(this.path)) {
			const stat = statSync(this.path);
			const disk = parseStore(readFileSync(this.path, "utf8")).document;
			if (disk.revision !== this.stored.revision ||
				(this.observedMtimeMs !== undefined && stat.mtimeMs !== this.observedMtimeMs)) {
				throw new Error("config changed in another pi session; rerun the command");
			}
		}
		const next: StoredCcStyleConfig = {
			...this.stored,
			revision: this.stored.revision + 1,
			overrides: nextOverrides as StoredCcStyleConfig["overrides"],
		};
		this.conf ??= createConfigStorage(dirname(this.path));
		this.conf.store = next;
		this.stored = next;
		this.observedMtimeMs = statSync(this.path).mtimeMs;
	}

	private compose(overrides: DeepPartial<EffectiveCcStyleConfig>): EffectiveCcStyleConfig {
		const effective = merge(DEFAULT_EFFECTIVE_CONFIG, overrides);
		for (const [path, name] of Object.entries(ENV_VALUES)) {
			const value = envBoolean(this.env[name]);
			if (value !== undefined) setPath(effective as unknown as Record<string, unknown>, path, value);
		}
		return effective;
	}

	private desiredValue(path: string, descriptor: ConfigDescriptor): unknown {
		const envName = ENV_VALUES[path];
		const envValue = envName ? envBoolean(this.env[envName]) : undefined;
		return envValue ?? getPath(this.stored.overrides, path) ?? descriptor.defaultValue;
	}

}

export function parseConfigValue(input: string): unknown {
	const value = input.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
	if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
		return JSON.parse(value);
	}
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}
