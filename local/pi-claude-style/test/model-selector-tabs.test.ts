import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { initTheme, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { TabStrip } from "pi-li-uikit/tab-strip";
import {
	installProviderTabbedModelSelector,
	modelSelectorTabs,
	renderModelSelectorTabs,
} from "../src/model-selector-tabs.ts";
import { ModelCapacityClient } from "../src/model-capacity-client.ts";
import {
	MODEL_CAPACITY_REQUEST_CHANNEL,
	MODEL_CAPACITY_READY_CHANNEL,
	MODEL_CAPACITY_SNAPSHOT_CHANNEL,
	MODEL_CAPACITY_WATCH_CHANNEL,
} from "../src/integration-contracts.ts";
import { auditInternals, resetInternals, setHealthPath, flushInternalsHealth } from "../src/internals.ts";
import { prepareModelSelectorRow } from "../src/compat/model-selector.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function model(provider: string, id: string) {
	return {
		provider,
		id,
		name: `${provider} ${id}`,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

const MODELS = [
	model("anthropic", "claude-sonnet"),
	model("anthropic", "claude-opus"),
	model("openai", "gpt-5"),
];

function selector(
	scopedModels: Array<{ model: ReturnType<typeof model> }> = [],
	models = MODELS,
	onSave?: () => void,
) {
	const renders = { count: 0 };
	const runtime = {
		getAvailableSnapshot: () => models,
		getModel: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
		refresh: async () => ({ aborted: false, errors: new Map() }),
		getError: () => undefined,
	};
	const component = new ModelSelectorComponent(
		{ requestRender: () => { renders.count++; } } as never,
		models.at(-1) as never,
		runtime as never,
		scopedModels as never,
		() => {},
		() => {},
		undefined,
		onSave,
	);
	return { component, renders };
}

function rendered(component: ModelSelectorComponent): string[] {
	return component.render(100).map((line) => strip(line).trimEnd());
}

function tabLine(lines: readonly string[]): string {
	return lines.find((line) => line.includes("anthropic (2)") && line.includes("openai (1)")) ?? "";
}

function tabColumns(line: string): number[] {
	return ["anthropic (2)", "openai (1)"].map((label) => line.indexOf(label));
}

class ContractBus {
	private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
	readonly emitted: Array<{ channel: string; payload: unknown }> = [];

	on(channel: string, handler: (payload: unknown) => void): () => void {
		const list = this.handlers.get(channel) ?? [];
		list.push(handler);
		this.handlers.set(channel, list);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			const index = list.indexOf(handler);
			if (index >= 0) list.splice(index, 1);
		};
	}

	emit(channel: string, payload: unknown): void {
		this.emitted.push({ channel, payload });
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(payload);
	}
}

let healthDir = "";
let restore: () => void = () => {};

beforeEach(() => {
	healthDir = mkdtempSync(join(tmpdir(), "model-selector-tabs-"));
	initTheme("dark");
	resetInternals();
	setHealthPath(join(healthDir, "health.json"));
	restore = installProviderTabbedModelSelector();
});

afterEach(async () => {
	restore();
	await flushInternalsHealth();
	resetInternals();
	rmSync(healthDir, { recursive: true, force: true });
});

test("capacity owner and model selector presenter share exact channels", () => {
	const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
	const owner = readFileSync(join(dirname(workspace), "pi-model-capacity/src/contracts.ts"), "utf8");
	const channels = Object.fromEntries(
		[...owner.matchAll(/export const (MODEL_CAPACITY_[A-Z_]+_CHANNEL) = "([^"]+)";/g)]
			.map((match) => [match[1], match[2]]),
	);
	assert.equal(channels.MODEL_CAPACITY_SNAPSHOT_CHANNEL, MODEL_CAPACITY_SNAPSHOT_CHANNEL);
	assert.equal(channels.MODEL_CAPACITY_REQUEST_CHANNEL, MODEL_CAPACITY_REQUEST_CHANNEL);
	assert.equal(channels.MODEL_CAPACITY_WATCH_CHANNEL, MODEL_CAPACITY_WATCH_CHANNEL);
	assert.equal(channels.MODEL_CAPACITY_READY_CHANNEL, MODEL_CAPACITY_READY_CHANNEL);
	assert.match(owner, /providers\?: CapacityProviderId\[\]/);
	assert.match(owner, /refreshProviders\?: CapacityProviderId\[\]/);
	assert.match(owner, /refresh\?: ModelCapacityRefreshReceiptV2/);
	assert.match(owner, /quota\?: ModelQuota/);
	assert.match(owner, /balances\?: CapacityBalance\[\]/);
	assert.match(owner, /type CapacityProviderId = string/);
	assert.match(owner, /ownerId: string/);
	const presenter = readFileSync(join(workspace, "src/model-capacity.ts"), "utf8");
	assert.match(presenter, /ModelCapacityRefreshReceiptV2/);
	assert.match(presenter, /quota\?: ModelQuota/);
	assert.match(presenter, /balances\?: CapacityBalance\[\]/);
	assert.match(presenter, /type CapacityProviderId = string/);
	assert.match(presenter, /ownerId: string/);
});

test("builds one provider tab per provider plus the optional scoped tab", () => {
	assert.deepEqual(modelSelectorTabs(MODELS as never, false), [
		"provider:anthropic",
		"provider:openai",
	]);
	assert.deepEqual(modelSelectorTabs(MODELS as never, true), [
		"scoped",
		"provider:anthropic",
		"provider:openai",
	]);
	assert.equal(
		strip(renderModelSelectorTabs(
			["provider:anthropic", "provider:openai"],
			"provider:openai",
			{ "provider:anthropic": 2, "provider:openai": 1 },
		)),
		"   anthropic (2)   [openai (1)]",
	);
});

test("the native selector opens on the current provider and tabs between provider slices", () => {
	const { component } = selector();
	let lines = rendered(component);
	const listContainer = (component as unknown as { listContainer: { children: unknown[] } })
		.listContainer;
	assert.ok(listContainer.children.some((child) => child instanceof TabStrip));
	const initialTabs = tabLine(lines);
	assert.ok(initialTabs.includes("[openai (1)]"));
	const initialTabColumns = tabColumns(initialTabs);
	assert.ok(lines.some((line) => line.includes("gpt-5")));
	assert.ok(!lines.some((line) => line.includes("claude-sonnet")));
	assert.ok(lines.at(-1)?.includes("Tab/Shift+Tab provider"));
	const fixedHeight = lines.length;

	component.handleInput("\t");
	lines = rendered(component);
	assert.equal(lines.length, fixedHeight, "provider tabs retain the largest content height");
	const switchedTabs = tabLine(lines);
	assert.ok(switchedTabs.includes("[anthropic (2)]"));
	assert.deepEqual(tabColumns(switchedTabs), initialTabColumns, "tab columns do not jump");
	assert.ok(lines.some((line) => line.includes("claude-sonnet")));
	assert.ok(!lines.some((line) => line.includes("gpt-5")));

	component.handleInput("\x1b[Z");
	lines = rendered(component);
	assert.ok(tabLine(lines).includes("[openai (1)]"));
	component.handleInput("z");
	lines = rendered(component);
	assert.ok(lines.some((line) => line.includes("No matching models")));
	assert.equal(lines.length, fixedHeight, "empty search results retain the fixed height");
	component.dispose();
});

test("configured scoped models become a first-class tab", () => {
	const { component } = selector([{ model: MODELS[1]! }]);
	let lines = rendered(component);
	const initialTabs = tabLine(lines);
	assert.ok(initialTabs.includes("[scoped (1)]"));
	const initialTabColumns = tabColumns(initialTabs);
	assert.ok(lines.some((line) => line.includes("claude-opus")));
	assert.ok(!lines.some((line) => line.includes("Scope:")), "native scope rows are replaced");

	component.handleInput("\t");
	lines = rendered(component);
	const switchedTabs = tabLine(lines);
	assert.ok(switchedTabs.includes("[anthropic (2)]"));
	assert.deepEqual(tabColumns(switchedTabs), initialTabColumns, "tab columns do not jump");
	assert.ok(lines.some((line) => line.includes("claude-sonnet")));
	component.dispose();
});

test("capacity owner-first snapshot renders immediately and selector lifecycle watches it", async () => {
	restore();
	const bus = new ContractBus();
	bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (payload) => {
		const request = payload as { reply?: (snapshot: unknown) => void };
		request.reply?.({
			version: 2,
			ownerId: "fixture-owner",
			revision: 1,
			providers: [
				{ provider: "fixture-gateway", state: "ready", observedAt: Date.now(), staleAfter: Date.now() + 30_000, gateway: { active: 4, queued: 1, backgroundActive: 0, maxActive: 20 }, models: { sol: { loadPercent: 145, quota: { remaining: 293, limit: 300 } }, "sol-max": { loadPercent: 145, quota: { remaining: 293, limit: 300 } } } },
				{ provider: "fixture-quota", state: "unavailable" },
				{ provider: "openai-codex", state: "ready", windows: [] },
				{ provider: "xai", state: "ready", windows: [] },
			],
		});
	});
	const client = new ModelCapacityClient(bus as never);
	const installRestore = installProviderTabbedModelSelector(client);
	restore = () => {
		installRestore();
		client.dispose();
	};
	const gatewayModels = [model("fixture-gateway", "sol"), model("fixture-gateway", "sol-max"), model("fixture-gateway", "terra")];
	const { component } = selector([], gatewayModels);
	await new Promise((resolve) => setImmediate(resolve));
	const lines = rendered(component);
	assert.ok(lines.some((line) => line.includes("Model catalogs refreshed. · Gateway 4/20 · Queue 1 · updated just now")));
	assert.equal(lines.filter((line) => line.includes("Model catalogs refreshed.")).length, 1);
	assert.ok(lines.some((line) => line.includes("sol") && line.includes("Q 293/300 · Load 145%")));
	assert.ok(lines.some((line) => line.includes("sol-max") && line.includes("Q 293/300 · Load 145%")));
	assert.ok(lines.some((line) => line.includes("terra") && !line.includes("Load")), "no model data does not imply a load capability");
	const acquire = bus.emitted.find(({ channel, payload }) =>
		channel === MODEL_CAPACITY_WATCH_CHANNEL && (payload as { action?: string }).action === "acquire");
	assert.ok(acquire, "opening the selector acquires live refresh");
	component.dispose();
	const release = bus.emitted.find(({ channel, payload }) =>
		channel === MODEL_CAPACITY_WATCH_CHANNEL && (payload as { action?: string }).action === "release");
	assert.equal(
		(release?.payload as { watcherId?: string }).watcherId,
		(acquire?.payload as { watcherId?: string }).watcherId,
	);
});

test("model rows align image and context after capacity and retain metadata at narrow widths", async () => {
	restore();
	const bus = new ContractBus();
	bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (payload) => {
		const request = payload as { reply?: (snapshot: unknown) => void };
		request.reply?.({ version: 2, ownerId: "fixture-owner", revision: 1, providers: [
			{ provider: "fixture-gateway", state: "ready", models: { sol: { loadPercent: 42, quota: { remaining: 293, limit: 300 } }, large: { loadPercent: 3 } } },
		] });
	});
	const client = new ModelCapacityClient(bus as never);
	const installRestore = installProviderTabbedModelSelector(client);
	restore = () => { installRestore(); client.dispose(); };
	const { component } = selector([], [
		{ ...model("fixture-gateway", "sol"), name: "Opus 4.7", contextWindow: 600_000, input: ["text", "image"] },
		{ ...model("fixture-gateway", "text-only"), contextWindow: 272_000 },
		{ ...model("fixture-gateway", "large"), contextWindow: 1_000_000, input: ["text", "image"] },
		{ ...model("fixture-gateway", "small"), contextWindow: 32_000 },
	]);
	await new Promise((resolve) => setImmediate(resolve));
	const row = (width: number, id = "sol") => component.render(width).map(strip).find((line) => line.includes(id) && !line.includes("Model Name:")) ?? "";
	assert.match(row(100), /Q 293\/300 · Load 42%\s+IMAGE  600k$/);
	assert.ok(!row(100).includes("[fixture-gateway]"));
	assert.match(row(100), /sol  Opus 4\.7/);
	assert.ok(!row(100, "text-only").includes("fixture-gateway text-only"), "default names ending in id are omitted");
	assert.ok(!row(50).includes("Opus 4.7"), "drop the name before capacity when both cannot fit");
	assert.match(row(50), /Q 293\/300 · Load 42%\s+IMAGE  600k$/);
	assert.match(row(24), /IMAGE  600k$/);
	assert.ok(!row(24).includes("Opus 4.7"), "drop the name before metadata at narrow widths");
	assert.ok(!row(34).includes("Opus 4.7"), "do not restore the name after dropping capacity");
	assert.ok(!row(24).includes("Load") && !row(24).includes("Q 293"));
	assert.ok(row(12).includes("sol") && !row(12).includes("600k"));
	assert.ok(row(18).includes("sol") && !row(18).includes("IMAGE"), "the wider marker drops as a whole when metadata cannot fit");
	const textRow = rendered(component).find((line) => line.includes("text-only") && !line.includes("Model Name:")) ?? "";
	assert.match(textRow, /272k/);
	assert.ok(!textRow.includes("IMAGE"));
	const largeRow = row(100, "large");
	const smallRow = row(100, "small");
	assert.match(largeRow, /Load 3%\s+IMAGE  1\.0M$/);
	assert.ok(textRow.endsWith("       272k"), "no image reserves the same IMAGE columns");
	assert.ok(smallRow.endsWith("      32.0k"));
	assert.deepEqual([row(100), textRow, largeRow, smallRow].map(visibleWidth), [100, 100, 100, 100]);
	assert.equal(visibleWidth(row(100).split("IMAGE")[0]!), visibleWidth(largeRow.split("IMAGE")[0]!), "different capacity lengths cannot move the image column");
	component.dispose();
	const { component: noCapacity } = selector([], [{ ...model("xai", "grok"), contextWindow: 1_000_000, input: ["text", "image"] }]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(rendered(noCapacity).some((line) => line.includes("grok") && !line.includes("[xai]") && line.endsWith("IMAGE 1.0M") && visibleWidth(line) === 100));
	noCapacity.dispose();
	const mixedModels = [{ ...model("fixture-gateway", "shared"), name: "Shared display" }, model("fixture-quota", "shared")];
	const { component: mixed } = selector(mixedModels.map((entry) => ({ model: entry })), mixedModels);
	await new Promise((resolve) => setImmediate(resolve));
	const mixedRows = rendered(mixed);
	assert.ok(mixedRows.some((line) => line.includes("shared  Shared display [fixture-gateway]")));
	assert.ok(mixedRows.some((line) => line.includes("shared [fixture-quota]")), mixedRows.join("\n"));
	const sharedRows = mixedRows.filter((line) => line.includes("shared") && !line.includes("Model Name:"));
	assert.deepEqual(sharedRows.map(visibleWidth), [100, 100], "with/without capacity both end on the same metadata column");
	assert.ok(sharedRows.every((line) => line.endsWith("      128k")));
	mixed.dispose();

	const bracketId = "sol[fixture-gateway]-variant";
	const item = { provider: "fixture-gateway", id: bracketId, model: model("fixture-gateway", bracketId) };
	const defaultRow = new Text(`→ ✓ ${bracketId} [fixture-gateway] · default`);
	prepareModelSelectorRow(defaultRow, item, true)();
	assert.equal(defaultRow.render(100).map(strip).find((line) => line.includes(bracketId))?.trim(), `→ ✓ ${bracketId} · default`);
	const noSlot = new Text(`→ ✓ ${bracketId}`);
	assert.throws(() => prepareModelSelectorRow(noSlot, item, true), /provider slot/);
	assert.equal(noSlot.render(100).map(strip).find((line) => line.includes(bracketId))?.trim(), `→ ✓ ${bracketId}`);

	restore();
	const prototype = ModelSelectorComponent.prototype as unknown as { updateList(this: unknown): void };
	const nativeUpdate = prototype.updateList;
	let fault: "shape" | "slot" = "shape";
	prototype.updateList = function () {
		nativeUpdate.call(this);
		const host = this as { filteredModels: Array<{ id: string }>; listContainer: { children: Component[] } };
		if (host.filteredModels.length < 2) return;
		const nativeRow = host.listContainer.children[1]!;
		if (fault === "shape") {
			host.listContainer.children[1] = { render: (width) => nativeRow.render(width), invalidate: () => nativeRow.invalidate() };
		} else {
			(nativeRow as Text).setText(`    ${host.filteredModels[1]!.id}`);
		}
	};
	const restoreFaulty = installProviderTabbedModelSelector();
	restore = () => { restoreFaulty(); prototype.updateList = nativeUpdate; };
	for (fault of ["shape", "slot"] as const) {
		const { component: degraded } = selector([], [
			model("fixture-quota", "other"),
			{ ...model("fixture-gateway", "z[fixture-gateway]-variant"), contextWindow: 600_000, input: ["text", "image"] },
			{ ...model("fixture-gateway", "a-good"), contextWindow: 600_000, input: ["text", "image"] },
		]);
		await new Promise((resolve) => setImmediate(resolve));
		const lines = rendered(degraded);
		assert.ok(lines.some((line) => line.includes("fixture-gateway (2)") && line.includes("fixture-quota (1)")));
		assert.ok(lines.at(-1)?.includes("Tab/Shift+Tab provider"));
		assert.ok(lines.some((line) => line.includes("a-good (fixture-gateway a-good) [fixture-gateway]")), `preflight keeps earlier rows native too: ${fault}: ${JSON.stringify(lines)}`);
		assert.ok(!lines.some((line) => line.includes("600k")));
		if (fault === "slot") assert.ok(lines.some((line) => line.trim() === "z[fixture-gateway]-variant"));
		assert.equal(auditInternals().find((entry) => entry.id === "model-selector-tabs.fields")?.state, "broken");
		degraded.handleInput("\t");
		assert.ok(rendered(degraded).some((line) => line.includes("other")));
		assert.equal(auditInternals().find((entry) => entry.id === "model-selector-tabs.fields")?.state, "ok");
		degraded.handleInput("\x1b[Z");
		assert.equal(auditInternals().find((entry) => entry.id === "model-selector-tabs.fields")?.state, "broken", "input/filter cannot overwrite row failure");
		degraded.dispose();
	}
});

test("Fixture Quota shared quota decorates the provider summary once instead of every model row", async () => {
	restore();
	const bus = new ContractBus();
	bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (payload) => {
		const request = payload as { reply?: (snapshot: unknown) => void };
		request.reply?.({
			version: 2,
			ownerId: "fixture-owner",
			revision: 1,
			providers: [{
				provider: "fixture-quota",
				state: "ready",
				observedAt: Date.now(),
				staleAfter: Date.now() + 30_000,
				windows: [{ kind: "other", label: "Shared", usedPercent: 2.4, remainingPercent: 97.6 }],
			}],
		});
	});
	const client = new ModelCapacityClient(bus as never);
	const installRestore = installProviderTabbedModelSelector(client);
	restore = () => {
		installRestore();
		client.dispose();
	};
	const quotaModels = [model("fixture-quota", "glm-5.3"), model("fixture-quota", "kimi-k3")];
	const { component } = selector([], quotaModels);
	await new Promise((resolve) => setImmediate(resolve));
	const lines = rendered(component);
	assert.equal(lines.filter((line) => line.includes("Shared 97.6% left")).length, 1);
	assert.ok(lines.some((line) => line.includes("glm-5.3")));
	assert.ok(lines.some((line) => line.includes("kimi-k3")));
	assert.ok(!lines.some((line) => line.includes("Q 97.6/100")));
	component.dispose();
});

test("capacity consumer-first snapshot updates an open selector in place", async () => {
	restore();
	const bus = new ContractBus();
	const client = new ModelCapacityClient(bus as never);
	const installRestore = installProviderTabbedModelSelector(client);
	restore = () => {
		installRestore();
		client.dispose();
	};
	const gatewayModels = [
		model("fixture-gateway", "sol"),
		model("fixture-gateway", "sol-max"),
		model("fixture-gateway", "terra"),
	];
	const { component, renders } = selector([], gatewayModels);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(rendered(component).some((line) => line.includes("Model catalogs refreshed.")));
	assert.equal(rendered(component).some((line) => line.includes("Capacity unavailable")), false, "unregistered providers have no invented capacity support");
	component.handleInput("s");
	component.handleInput("o");
	component.handleInput("l");
	component.handleInput("\x1b[B");
	const host = component as unknown as {
		filteredModels: Array<{ id: string }>;
		selectedIndex: number;
	};
	assert.equal(host.filteredModels[host.selectedIndex]?.id, "sol-max");
	const before = renders.count;
	bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, {
		version: 2,
		ownerId: "fixture-owner",
		revision: 2,
		providers: [
			{
				provider: "fixture-gateway",
				state: "refreshing",
				models: {
					sol: { loadPercent: 12 },
					"sol-max": { loadPercent: 24 },
					terra: { loadPercent: 36 },
				},
			},
			{ provider: "openai-codex", state: "unavailable" },
			{ provider: "xai", state: "unavailable" },
		],
	});
	const lines = rendered(component);
	assert.ok(renders.count > before, "snapshot requests a TUI redraw");
	assert.equal(host.filteredModels[host.selectedIndex]?.id, "sol-max");
	assert.ok(lines.some((line) => line.includes("Refreshing capacity…")));
	assert.ok(lines.some((line) => line.includes("sol") && line.includes("Load 12%")));
	assert.ok(lines.some((line) => line.includes("sol-max") && line.includes("Load 24%")));
	component.dispose();
});

test("DeepSeek tab footer shows account remaining from the shared capacity snapshot", async () => {
	restore();
	const bus = new ContractBus();
	bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (payload) => {
		const request = payload as { reply?: (snapshot: unknown) => void };
		request.reply?.({
			version: 2,
			ownerId: "fixture-owner",
			revision: 1,
			providers: [{
				provider: "deepseek",
				state: "ready",
				observedAt: Date.now(),
				staleAfter: Date.now() + 90_000,
				balances: [{ currency: "CNY", remaining: 9.21, granted: 0, toppedUp: 9.21 }],
			}],
		});
	});
	const client = new ModelCapacityClient(bus as never);
	const installRestore = installProviderTabbedModelSelector(client);
	restore = () => {
		installRestore();
		client.dispose();
	};
	const { component } = selector([], [model("deepseek", "deepseek-v4-pro")]);
	await new Promise((resolve) => setImmediate(resolve));
	const lines = rendered(component);
	assert.ok(lines.some((line) => line.includes("¥9.21")));
	assert.ok(lines.some((line) => line.includes("deepseek-v4-pro")));
	assert.equal(lines.filter((line) => /Q \d/.test(line)).length, 0);
	component.dispose();
});

test("model selection and provider shortcuts live only in the right-aligned footer rule", () => {
  const { component } = selector([], MODELS, () => {});
  const lines = component.render(120).map(strip);
  const footer = lines.at(-1)!;
  assert.match(footer, /^─+ .*select.*default.*Tab\/Shift\+Tab provider.* ──$/);
  assert.ok(!lines.slice(0, -1).some((line) => /to select|to set as default|to cancel/.test(line)));
  const narrow = component.render(40).map(strip).at(-1)!;
  assert.ok(visibleWidth(narrow) <= 40);
  assert.match(narrow, /close.* ──$/);
  component.dispose();
});
