import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TextPanelContent } from "pi-li-uikit/text-panel";
import { ConfigService, parseConfigValue, type ConfigMutation } from "../config/service.ts";
import { CcStyleObservability } from "../observability.ts";
import type { LifecycleManager } from "../lifecycle.ts";
import { loadRuntimeModuleOnFirstUse, type RuntimeScope } from "../runtime-scope.ts";
import type { UiScheduler } from "../ui-scheduler.ts";
import {
	cacheHistoryPanelContent,
	emptyCacheHistory,
	formatCacheHistoryPlain,
} from "../statusline/cache-panel.ts";
import type { CacheHistorySnapshot } from "../statusline/cache-history.ts";

type EditorPanelModule = typeof import("pi-li-uikit/editor-panel");
type TextPanelModule = typeof import("pi-li-uikit/text-panel");

export interface CcStyleCommandRuntime {
	runtime: RuntimeScope;
	observability: CcStyleObservability;
	scheduler?: UiScheduler;
}

async function loadEditorPanel(runtime?: CcStyleCommandRuntime): Promise<EditorPanelModule | undefined> {
	if (!runtime) return import("pi-li-uikit/editor-panel");
	return loadRuntimeModuleOnFirstUse(
		runtime.runtime,
		"command-editor-panel",
		() => import("pi-li-uikit/editor-panel"),
		runtime.observability,
	);
}

async function loadTextPanel(runtime?: CcStyleCommandRuntime): Promise<TextPanelModule | undefined> {
	if (!runtime) return import("pi-li-uikit/text-panel");
	return loadRuntimeModuleOnFirstUse(
		runtime.runtime,
		"shared-text-panel-ui",
		() => import("pi-li-uikit/text-panel"),
		runtime.observability,
	);
}

async function withLoadingStatus<T>(
	ctx: ExtensionCommandContext,
	runtime: CcStyleCommandRuntime | undefined,
	action: () => Promise<T>,
): Promise<T> {
	let shown = false;
	const timer = (runtime?.scheduler?.setTimer.bind(runtime.scheduler) ?? setTimeout)(() => {
		try {
			ctx.ui.setStatus("cc-style:lazy-ui", "Loading CC Style UI…");
			shown = true;
		} catch {
			shown = false;
		}
	}, 50);
	try {
		return await action();
	} finally {
		if (runtime?.scheduler) runtime.scheduler.clearTimer(timer);
		else clearTimeout(timer);
		if (shown) {
			try { ctx.ui.setStatus("cc-style:lazy-ui", undefined); } catch { /* stale UI */ }
		}
	}
}

/** Preload command-only UIKit modules after first frame when conf requests it. */
export async function preloadCcStyleCommandUi(runtime: CcStyleCommandRuntime): Promise<void> {
	await Promise.all([loadEditorPanel(runtime), loadTextPanel(runtime)]);
}

export interface CcStyleCommandResult {
	title: string;
	text: string;
	long?: boolean;
	panel?: TextPanelContent;
}

interface CcStyleCommandOptions {
	resetAllConfirmed?: boolean;
	lifecycle?: LifecycleManager;
	runtime?: RuntimeScope;
	cacheHistory?: CacheHistorySnapshot;
}

export type CacheHistoryLoader = (
	ctx: ExtensionCommandContext,
) => Promise<CacheHistorySnapshot>;

function value(value: unknown): string {
	return value === undefined ? "(unset)" : typeof value === "string" ? value : JSON.stringify(value);
}

function mutationText(mutation: ConfigMutation): string {
	return [
		`${mutation.path}: ${value(mutation.old)} → ${value(mutation.next)}`,
		`source=${mutation.source} apply=${mutation.apply} revision=${mutation.revision}`,
		mutation.source === "env" ? "environment override still masks the stored value" : undefined,
		mutation.pending !== undefined ? `${mutation.apply} required; pending=${value(mutation.pending)}` : "active now",
	].filter(Boolean).join("\n");
}

function status(service: ConfigService, lifecycle?: LifecycleManager, runtime?: RuntimeScope): string {
	const active = service.active;
	const pending = service.diagnostics().pendingPaths;
	return [
		`config: ${service.path}`,
		`revision: ${service.revision}`,
		`transcript: ${active.features.transcript ? "on" : "off"}`,
		`working: ${active.features.working ? "on" : "off"}`,
		`loading: ${active.loading.mode}`,
		"extensions: Pi settings-owned (direct load)",
		`performance producer: ${active.performance.enabled ? "on" : "off"}`,
		lifecycle ? `lifecycle features: ${lifecycle.activeIds.join(", ") || "none"}` : undefined,
		runtime ? `runtime modules: ${formatModuleStates(runtime)}` : undefined,
		`pending reload/restart: ${pending.length ? pending.join(", ") : "none"}`,
	].filter((line): line is string => line !== undefined).join("\n");
}

function doctor(service: ConfigService, lifecycle?: LifecycleManager, runtime?: RuntimeScope): string {
	const state = service.diagnostics();
	const featureHealth = lifecycle
		? Object.entries(lifecycle.health()).map(([id, health]) =>
			`${health.status === "ok" ? "OK" : health.status === "inactive" ? "INFO" : "WARN"} feature ${id}: ${health.status}${health.detail ? ` — ${health.detail}` : ""}`)
		: [];
	return [
		state.degradedError ? `ERROR config is read-only: ${state.degradedError}` : "OK config parses and is writable",
		`path: ${service.path}`,
		state.degradedError
			? `recovery: /cc-style config reset-all --force (backs up the current bytes beside config.json)`
			: "recovery: not needed",
		`schema: v6 · revision ${state.revision}`,
		state.migration
			? `migration: ${state.migration.at} from ${state.migration.sources.map(({ path }) => path).join(", ")}`
			: "migration: no legacy inputs imported",
		state.unknownPaths.length ? `WARN unknown preserved paths: ${state.unknownPaths.join(", ")}` : "OK no unknown override paths",
		state.pendingPaths.length ? `INFO pending: ${state.pendingPaths.join(", ")}` : "OK no pending changes",
		...featureHealth,
		runtime ? `runtime modules: ${formatModuleStates(runtime)}` : undefined,
		"statusline.* is owned by Pi settings and is intentionally read-only here",
	].join("\n");
}

function formatModuleStates(runtime: RuntimeScope): string {
	const states = runtime.moduleDiagnostics();
	return Object.keys(states).length === 0
		? "none loaded"
		: Object.entries(states).map(([name, item]) =>
			`${name}=${item.state}${item.error ? `(${item.error})` : ""}`
		).join(", ");
}

function setArguments(args: string): { path: string; raw: string } | undefined {
	const match = /^config\s+set\s+(\S+)\s+([\s\S]+)$/i.exec(args.trim());
	return match ? { path: match[1]!, raw: match[2]! } : undefined;
}

export async function executeCcStyleCommand(
	args: string,
	service: ConfigService,
	observability: CcStyleObservability,
	options: CcStyleCommandOptions = {},
): Promise<CcStyleCommandResult> {
	const input = args.trim();
	const normalized = input.toLowerCase();
	if (!input || normalized === "status") return { title: "CC Style status", text: status(service, options.lifecycle, options.runtime) };
	if (normalized === "doctor") return { title: "CC Style doctor", text: doctor(service, options.lifecycle, options.runtime), long: true };
	if (normalized === "config" || normalized === "config list") {
		return {
			title: "CC Style config",
			text: service.list().map((entry) =>
				`${entry.path}=${value(entry.active)} [${entry.source}; ${entry.apply}${entry.pending !== undefined ? "; pending" : ""}]`
			).join("\n"),
			long: true,
		};
	}
	if (normalized.startsWith("config list ")) {
		const prefix = input.slice("config list ".length).trim();
		return {
			title: `CC Style config: ${prefix}`,
			text: service.list(prefix).map((entry) =>
				`${entry.path}=${value(entry.active)} [${entry.source}; ${entry.apply}]`
			).join("\n") || `no config paths under ${prefix}`,
			long: true,
		};
	}
	if (normalized === "config path") {
		return { title: "CC Style config path", text: service.path };
	}
	if (normalized.startsWith("config get ")) {
		const path = input.slice("config get ".length).trim();
		const entry = service.get(path);
		return {
			title: `CC Style config: ${path}`,
			text: [
				`active=${value(entry.active)}`,
				`stored=${value(entry.stored)}`,
				`pending=${value(entry.pending)}`,
				`source=${entry.source}`,
				`apply=${entry.apply}`,
			].join("\n"),
		};
	}
	const set = setArguments(input);
	if (set) {
		const mutation = service.set(set.path, parseConfigValue(set.raw));
		if (set.path.startsWith("performance.")) observability.configure(service.active.performance);
		return { title: `CC Style config set`, text: mutationText(mutation) };
	}
	if (normalized.startsWith("config reset ")) {
		const path = input.slice("config reset ".length).trim();
		const mutation = service.reset(path);
		if (path.startsWith("performance.")) observability.configure(service.active.performance);
		return { title: "CC Style config reset", text: mutationText(mutation) };
	}
	if (normalized === "config reset-all" || normalized === "config reset-all --yes") {
		if (normalized === "config reset-all" && !options.resetAllConfirmed) throw new Error("reset-all requires confirmation or --yes");
		service.resetAll();
		observability.configure(service.active.performance);
		return { title: "CC Style config reset", text: "all user overrides removed; reload/restart settings remain active until reapplied" };
	}
	if (normalized === "config reset-all --force") {
		const backup = service.recoverResetAll();
		observability.configure(service.active.performance);
		return {
			title: "CC Style config recovered",
			text: backup
				? `invalid config backed up to ${backup}\nfresh defaults written to ${service.path}`
				: `all user overrides removed from ${service.path}`,
		};
	}
	if (normalized === "perf" || normalized === "perf status") {
		return { title: "CC Style performance", text: observability.report(), long: true };
	}
	if (normalized === "perf reset") {
		observability.reset();
		return { title: "CC Style performance", text: "performance samples reset" };
	}
	if (normalized === "perf on" || normalized === "perf off") {
		const enabled = normalized.endsWith("on");
		service.set("performance.enabled", enabled);
		observability.configure(service.active.performance);
		return { title: "CC Style performance", text: `cc-style producer ${enabled ? "on" : "off"}; pi-perf provider state is reported separately` };
	}
	if (normalized === "perf log on" || normalized === "perf log off") {
		const enabled = normalized.endsWith("on");
		service.set("performance.logEnabled", enabled);
		observability.configure(service.active.performance);
		return { title: "CC Style performance", text: `slow-sample log ${enabled ? "on" : "off"}` };
	}
	if (normalized === "cache") {
		if (!options.cacheHistory) throw new Error("cache history is unavailable");
		const panel = cacheHistoryPanelContent(options.cacheHistory);
		return {
			title: panel.title,
			text: formatCacheHistoryPlain(options.cacheHistory),
			long: true,
			panel,
		};
	}
	throw new Error("usage: /cc-style [status|cache|config list|get|set|reset|reset-all [--yes|--force]|path|perf|doctor]");
}

export async function presentCcStyleResult(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: CcStyleCommandResult,
	runtime?: CcStyleCommandRuntime,
): Promise<void> {
	if (!ctx.hasUI) {
		pi.sendMessage({
			customType: "cc-style.command-output",
			content: `${result.title}\n${result.text}`,
			display: true,
			details: { title: result.title },
		}, { triggerTurn: false });
		return;
	}
	if (result.long && ctx.mode === "tui") {
		const ui = await withLoadingStatus(ctx, runtime, () => loadTextPanel(runtime));
		if (!ui) return;
		await ui.showTextPanel(ctx, result.panel ?? {
			title: result.title,
			body: result.text,
			format: "plain",
		});
		return;
	}
	ctx.ui.notify(result.text, "info");
}

type PanelScreenId = "main" | "config" | "perf" | "doctor";

async function showMainPanel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	service: ConfigService,
	observability: CcStyleObservability,
	lifecycle?: LifecycleManager,
	runtime?: CcStyleCommandRuntime,
	loadCacheHistory?: CacheHistoryLoader,
): Promise<void> {
	const ui = await withLoadingStatus(ctx, runtime, () => loadEditorPanel(runtime));
	if (!ui) return;
	const commandOptions = { lifecycle, runtime: runtime?.runtime };
	const cacheResult = async () => executeCcStyleCommand(
		"cache",
		service,
		observability,
		{ ...commandOptions, cacheHistory: await loadCacheHistory?.(ctx) ?? emptyCacheHistory() },
	);
	await ui.showEditorPanel<PanelScreenId>(ctx, {
		initialScreen: "main",
		getScreen: (id) => {
			if (id === "main") return {
				id,
				title: "CC Style",
				breadcrumbs: [],
				items: [
					{ id: "status", label: "Status", description: "feature and pending state", onSelect: async () => presentCcStyleResult(pi, ctx, await executeCcStyleCommand("status", service, observability, commandOptions), runtime) },
					{ id: "config", label: "Config", description: "catalog values", transition: { kind: "push", screen: "config" } },
					{ id: "perf", label: "Performance", description: "metrics and spans", transition: { kind: "push", screen: "perf" } },
					{
						id: "cache",
						label: "Prompt cache",
						description: "CH/RU trends and request details",
						onSelect: async () => presentCcStyleResult(pi, ctx, await cacheResult(), runtime),
					},
					{ id: "doctor", label: "Doctor", description: "health and migration", transition: { kind: "push", screen: "doctor" } },
				],
			};
			if (id === "config") return {
				id,
				title: "Config",
				breadcrumbs: ["CC Style"],
				items: [
					{
						id: "open-config",
						label: "Open config report",
						description: "all values · selectable, copyable overlay",
						onSelect: async () => presentCcStyleResult(pi, ctx, await executeCcStyleCommand("config", service, observability, commandOptions), runtime),
					},
				],
			};
			return {
				id,
				title: id === "perf" ? "Performance" : "Doctor",
				breadcrumbs: ["CC Style"],
				items: [{
					id: `open-${id}`,
					label: `Open ${id} report`,
					description: "selectable, copyable overlay",
					onSelect: async () => presentCcStyleResult(pi, ctx, await executeCcStyleCommand(id, service, observability, commandOptions), runtime),
				}],
			};
		},
	});
}

export function registerCcStyleCommand(
	pi: ExtensionAPI,
	service: ConfigService,
	observability: CcStyleObservability,
	lifecycle?: LifecycleManager,
	runtime?: RuntimeScope,
	scheduler?: UiScheduler,
	loadCacheHistory?: CacheHistoryLoader,
): void {
	const commandRuntime = runtime ? { runtime, observability, scheduler } : undefined;
	const commandOptions = { lifecycle, runtime };
	pi.registerCommand("cc-style", {
		description: "Configure and diagnose Claude-style UI; inspect shared performance metrics",
		getArgumentCompletions: (prefix: string) => {
			const commands = ["status", "cache", "config", "config list", "config path", "config reset-all", "config reset-all --yes", "config reset-all --force", "perf", "perf on", "perf off", "perf reset", "perf log on", "perf log off", "doctor"];
			const paths = service.catalog.flatMap(({ path, choices, description }) => [
				`config get ${path}`, `config reset ${path}`,
				...(choices ? choices.map(value => `config set ${path} ${String(value)}`) : [`config set ${path} `]),
			].map(value => ({ value, label: value, description })));
			return [...commands.map(value => ({ value, label: value })), ...paths]
				.filter(entry => entry.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			try {
				if (!args.trim()) {
					if (ctx.hasUI) {
						await showMainPanel(
							pi,
							ctx,
							service,
							observability,
							lifecycle,
							commandRuntime,
							loadCacheHistory,
						);
					} else {
						await presentCcStyleResult(pi, ctx, await executeCcStyleCommand("status", service, observability, commandOptions), commandRuntime);
					}
					return;
				}
				let confirmed = false;
				const normalized = args.trim().toLowerCase();
				if (normalized === "config reset-all" && !ctx.hasUI) {
					await presentCcStyleResult(pi, ctx, {
						title: "CC Style confirmation required",
						text: "interactive confirmation is unavailable; use `config reset-all --yes` for an ordinary reset, or `--force` only to recover a degraded store with backup",
					}, commandRuntime);
					return;
				}
				if (normalized === "config reset-all" || normalized === "config reset-all --force") {
					confirmed = ctx.hasUI && await ctx.ui.confirm(
						normalized.endsWith("--force") ? "Recover CC Style configuration?" : "Reset all CC Style overrides?",
						normalized.endsWith("--force")
							? "The invalid config will be backed up beside config.json before fresh defaults are written."
							: "Legacy files are kept; reload/restart values remain active until restart.",
					);
					if (!confirmed) return;
				}
				const cacheHistory = normalized === "cache"
					? await loadCacheHistory?.(ctx) ?? emptyCacheHistory()
					: undefined;
				await presentCcStyleResult(
					pi,
					ctx,
					await executeCcStyleCommand(args, service, observability, {
						...commandOptions,
						resetAllConfirmed: confirmed,
						cacheHistory,
					}),
					commandRuntime,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else pi.sendMessage({ customType: "cc-style.command-error", content: message, display: true }, { triggerTurn: false });
			}
		},
	});
}
