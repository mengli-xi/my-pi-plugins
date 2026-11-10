import { constants, closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, validateGuidanceFields } from "@juicesharp/rpiv-config";

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";
export const DEFAULT_NOTES_KEY = "n";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
	/**
	 * Key that opens the notes editor. Defaults to `"n"`. A single character of any
	 * script (e.g. `"т"` on a Cyrillic layout) matches as typed; anything else is a
	 * key spec in the `collapseKey` format, e.g. `"ctrl+n"`.
	 */
	notesKey?: string;
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	// Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
	// base key that is a single printable character or a named special key. A loose
	// check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
	// and ignores unknown parts, so a typo like `ctr+]` would silently match every
	// bare `]` keypress (and the raw terminal listener would consume them globally).
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = typeof config.collapseKey === "string" ? config.collapseKey.trim().toLowerCase() : undefined;
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

// Keys the questionnaire already navigates with — a notes key on one of them would shadow it.
const NOTES_KEY_RESERVED = new Set(["space", "enter", "return", "tab", "escape", "esc", "up", "down", "left", "right"]);

export function resolveNotesKey(config: Pick<AskUserQuestionConfig, "notesKey">): string {
	const raw = typeof config.notesKey === "string" ? config.notesKey.trim() : undefined;
	if (!raw) return DEFAULT_NOTES_KEY;
	if ([...raw].length === 1) return raw;
	const spec = raw.toLowerCase();
	return isValidCollapseKeySpec(spec) && !NOTES_KEY_RESERVED.has(spec) ? spec : DEFAULT_NOTES_KEY;
}

/** A single-character notes key shows as configured (`n`, not `N`); a spec is display-cased. */
export function formatNotesKeyForDisplay(notesKey: string): string {
	return [...notesKey].length === 1 ? notesKey : formatKeySpecForDisplay(notesKey);
}

// The only compound-word names in SPECIAL_KEYS — first-letter capitalization
// alone would render them "Pageup"/"Pagedown".
const COMPOUND_KEY_DISPLAY: Record<string, string> = {
	pageup: "PageUp",
	pagedown: "PageDown",
};

/**
 * Pretty-print a resolved key spec for UI copy: each `+`-part gets its first
 * character uppercased (`"ctrl+]"` → `"Ctrl+]"`, `"alt+o"` → `"Alt+O"`,
 * `"f9"` → `"F9"`, `"ctrl+pagedown"` → `"Ctrl+PageDown"`). Display-only — key
 * matching always uses the raw lowercase spec (`matchesKey` lowercases ids),
 * so never feed the result back into it.
 */
export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map(
			(part) =>
				COMPOUND_KEY_DISPLAY[part] ??
				(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}

const CONFIG_NAME = "rpiv-ask-user-question";
let cachedConfig: { path: string; version: string; value: AskUserQuestionConfig } | undefined;

type ConfigFile = { version: string; stats?: BigIntStats; error?: unknown };

function fileVersion(stats: BigIntStats): string {
	return `${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

function inspectConfig(path: string): ConfigFile {
	try {
		const stats = statSync(path, { bigint: true });
		return { version: fileVersion(stats), stats };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { version: "missing" };
		return { version: `error:${String(error)}`, error };
	}
}

export function loadConfig(): AskUserQuestionConfig {
	let path = configPath(CONFIG_NAME);
	let file = inspectConfig(path);
	// rpiv-config 2.15 exposes the XDG resolver, but not its legacy resolver.
	// Its documented fallback is ~/.config, and only an absent XDG file permits it.
	if (file.version === "missing") {
		const legacyPath = join(homedir(), ".config", CONFIG_NAME, "config.json");
		if (legacyPath !== path) {
			path = legacyPath;
			file = inspectConfig(path);
		}
	}
	if (cachedConfig?.path === path && cachedConfig.version === file.version) return cachedConfig.value;

	let value: AskUserQuestionConfig = {};
	let fd: number | undefined;
	try {
		if (file.error) throw file.error;
		if (file.stats) {
			if (!file.stats.isFile()) throw new Error("config is not a regular file");
			// The public rpiv-config 2.15 reader accepts only a path and reads it
			// synchronously. Use a nonblocking fd so a FIFO replacement cannot hang
			// startup; fstat also rejects other non-regular files before reading.
			fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
			const stats = fstatSync(fd, { bigint: true });
			file.version = fileVersion(stats);
			if (!stats.isFile()) throw new Error("config is not a regular file");
			const text = readFileSync(fd, "utf8");
			try {
				const parsed: unknown = JSON.parse(text);
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
					value = parsed as AskUserQuestionConfig;
				}
			} catch (error) {
				const location = error instanceof SyntaxError ? /position \d+(?: \(line \d+ column \d+\))?/.exec(error.message)?.[0] : undefined;
				console.warn(`rpiv-config: invalid JSON at ${path}, using default ({}) — ${error instanceof Error ? error.name : "parse error"}${location ? ` at ${location}` : ""}`);
			}
		}
	} catch (error) {
		console.warn(`rpiv-config: cannot read config at ${path}, using default ({}) — ${String(error)}`);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	cachedConfig = { path, version: file.version, value };
	return value;
}

export { validateGuidanceFields };
