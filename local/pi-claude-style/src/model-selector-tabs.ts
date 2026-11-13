/**
 * Provider tabs for Pi's built-in `/model` selector.
 *
 * `/model` and Ctrl+L are handled before extension commands, so registering a
 * second command cannot replace the built-in window. The selector component is
 * exported, though, and its native implementation already owns everything we
 * should not copy: catalog refresh, fuzzy search, current-model marking,
 * persistence and selection callbacks. This patch keeps those paths and
 * changes only the list's grouping/navigation layer.
 */

import {
	getKeybindings,
	Key,
	matchesKey,
	Spacer,
	truncateToWidth,
	visibleWidth,
	stripTerminalSequences,
	type Component,
	type Container,
} from "@earendil-works/pi-tui";
import {
	nextTab,
	renderTabStrip,
	TabStrip,
	type TabStripItem,
} from "pi-li-uikit/tab-strip";
import { keyText } from "@earendil-works/pi-coding-agent";
import { panelFooterRule } from "pi-li-uikit/panel-footer";
import { ansi256, claudeIndicatorPalette, RESET_FG } from "./cyber-style.ts";
import {
	modelSelectorCompat,
	modelSelectorCapabilities,
	prepareModelSelectorRow,
	modelSelectorPrototype,
	type CompatModelItem as ModelItem,
	type CompatModelLike as ModelLike,
	type ModelSelectorCompat,
} from "./compat/model-selector.ts";
import { declareProbes, markBroken, markOk, type Probe } from "./internals.ts";
import { formatTokenCount } from "./format.ts";
import type { ModelCapacitySource } from "./model-capacity-client.ts";
import {
	formatModelCapacityColored,
	formatProviderCapacityColored,
	providerCapacity,
	type ModelCapacitySnapshotV2,
} from "./model-capacity.ts";

const PATCH_STATE = Symbol.for("pi-claude-style.model-selector-tabs.patch");
const PATCH_OWNER = Symbol("pi-claude-style.model-selector-tabs.owner");
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

type TabId = `provider:${string}` | "scoped";

interface SelectorState {
	tabs: TabId[];
	selected: TabId | undefined;
	watcherId?: string;
	nativeKeyHints?: Component;
}

type FilterModels = (this: unknown, query: string, preferredModel?: ModelLike) => void;
type UpdateList = (this: unknown) => void;
type HandleInput = (this: unknown, keyData: string) => void;
type Dispose = (this: unknown) => void;

interface PatchablePrototype {
	filterModels?: FilterModels;
	updateList?: UpdateList;
	handleInput?: HandleInput;
	dispose?: Dispose;
	setScope?: (this: unknown, scope: "all" | "scoped") => void;
	[key: symbol]: unknown;
}

interface PatchState {
	owner: symbol;
	originalFilter: FilterModels;
	originalUpdate: UpdateList;
	originalInput: HandleInput;
	originalDispose: Dispose;
	patchedFilter: FilterModels;
	patchedUpdate: UpdateList;
	patchedInput: HandleInput;
	patchedDispose: Dispose;
}

const MAX_VISIBLE_MODELS = 10;
const TAB_FOOTER_HINT = "Tab/Shift+Tab provider";
const CAPACITY_SUMMARY_PREFIX = "  ";
const CAPACITY_SEPARATOR = "  ";
const CAPACITY_THEME = {
	fg(color: "dim" | "muted" | "success" | "warning" | "error", text: string): string {
		const tone = {
			dim: ansi256(102),
			muted: ansi256(102),
			success: ansi256(65),
			warning: ansi256(101),
			error: ansi256(95),
		}[color];
		return `${tone}${text}${RESET_FG}`;
	},
};

/** @see workflows/patching-pi.md */
export const PROBES: Probe[] = [
	{
		id: "model-selector-tabs.methods",
		needs: "ModelSelectorComponent.prototype.filterModels/updateList/handleInput/dispose/setScope",
		breaks: "/model 退回未按 provider 分组的原生列表",
		check: () => {
			const prototype = modelSelectorPrototype<PatchablePrototype>();
			return typeof prototype.filterModels === "function"
				&& typeof prototype.updateList === "function"
				&& typeof prototype.handleInput === "function"
				&& typeof prototype.dispose === "function"
				&& typeof prototype.setScope === "function";
		},
	},
	{
		id: "model-selector-tabs.fields",
		needs: "ModelSelectorComponent 实例的模型数组、列表容器与原生行 Text.text、refreshStatusMessage/refreshStatusSuccess、根 children、closed 和 tui.requestRender 字段",
		breaks: "/model 退回未按 provider 分组的原生列表，catalog refresh 与 capacity 无法合并",
	},
];

function providerTabs(models: readonly ModelItem[]): TabId[] {
	return [...new Set(models.map((item) => item.provider))]
		.sort((left, right) => left.localeCompare(right))
		.map((provider) => `provider:${provider}` as const);
}

/** Pure tab inventory, exported for the interaction contract tests. */
export function modelSelectorTabs(
	models: readonly ModelItem[],
	hasScopedModels: boolean,
): TabId[] {
	return [
		...(hasScopedModels ? ["scoped" as const] : []),
		...providerTabs(models),
	];
}

function providerOf(tab: TabId | undefined): string | undefined {
	return tab?.startsWith("provider:") ? tab.slice("provider:".length) : undefined;
}

function tabLabel(tab: TabId): string {
	return tab === "scoped" ? "scoped" : tab.slice("provider:".length);
}

function tabItems(
	tabs: readonly TabId[],
	countFor?: (tab: TabId) => number | undefined,
): TabStripItem<TabId>[] {
	return tabs.map((tab) => ({
		value: tab,
		label: tabLabel(tab),
		count: countFor?.(tab),
	}));
}

const TAB_THEME = {
	active: (text: string) =>
		`${claudeIndicatorPalette.base}${BOLD}${text}${RESET_FG}${RESET}`,
	inactive: (text: string) => `${DIM}${text}${RESET}`,
	hint: (text: string) => `${DIM}${text}${RESET}`,
};

/** The model adapter's palette around pi-li-uikit's shared tab renderer. */
export function renderModelSelectorTabs(
	tabs: readonly TabId[],
	selected: TabId | undefined,
	counts: Partial<Record<TabId, number>> = {},
): string {
	return `  ${renderTabStrip({
		tabs: tabItems(tabs, (tab) => counts[tab]),
		selected,
		theme: TAB_THEME,
	})}`;
}

class TabHintBorder implements Component {
  private readonly nativeHints?: Component;
  constructor(nativeHints?: Component) { this.nativeHints = nativeHints; }
  render(width: number): string[] {
    const native = this.nativeHints
      ? stripTerminalSequences(this.nativeHints.render(1024).join(" ")).trim()
      : `${keyText("tui.select.confirm")} select · ${keyText("tui.select.cancel")} close`;
    const concise = native.replace(/ to select/g, " select")
      .replace(/ to set as default/g, " default").replace(/ to cancel/g, " close");
    const basic = `${keyText("tui.select.confirm")} select · ${keyText("tui.input.tab")} provider · ${keyText("tui.select.cancel")} close`;
    return [panelFooterRule({ fg: (_tone, text) => `${DIM}${text}${RESET}` }, width, [
      `${concise} · ${TAB_FOOTER_HINT}`,
      basic,
      `${keyText("tui.input.tab")} provider · ${keyText("tui.select.cancel")} close`,
    ])];
  }
  invalidate(): void { this.nativeHints?.invalidate?.(); }
}

class CatalogCapacitySummary implements Component {
	private readonly prefix: string;
	private readonly capacity: string;

	constructor(prefix: string, capacity: string) {
		this.prefix = prefix;
		this.capacity = capacity;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const line = `${CAPACITY_SUMMARY_PREFIX}${this.prefix}${CAPACITY_THEME.fg("dim", " · ")}${this.capacity}`;
		return [truncateToWidth(line, safeWidth, "…")];
	}

	invalidate(): void {}
}

class CapacityModelRow implements Component {
	private readonly source: Component;
	private readonly metadata: string | undefined;
	private readonly capacity: string | undefined;
	private readonly displayName: string | undefined;
	private readonly setRow: ((displayName?: string) => void) | undefined;

	constructor(
		source: Component,
		metadata: string | undefined,
		capacity: string | undefined,
		displayName: string | undefined,
		setRow: ((displayName?: string) => void) | undefined,
	) {
		this.source = source;
		this.metadata = metadata;
		this.capacity = capacity;
		this.displayName = displayName;
		this.setRow = setRow;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		this.setRow?.();
		return this.source.render(safeWidth).map((line, index) => {
			if (index > 0) return line;
			let base = line.trimEnd();
			let suffix = [this.capacity, this.metadata].filter(Boolean).join(CAPACITY_SEPARATOR);
			let gap = safeWidth - visibleWidth(base) - visibleWidth(suffix);
			const nameWidth = this.displayName ? visibleWidth(this.displayName) : 0;
			const showName = this.displayName && gap >= nameWidth + (suffix ? visibleWidth(CAPACITY_SEPARATOR) : 0);
			if (gap < visibleWidth(CAPACITY_SEPARATOR) && this.metadata) {
				suffix = this.metadata;
				gap = safeWidth - visibleWidth(base) - visibleWidth(suffix);
			}
			if (gap < visibleWidth(CAPACITY_SEPARATOR)) suffix = "";
			gap = safeWidth - visibleWidth(base) - visibleWidth(suffix);
			if (showName) {
				this.setRow?.(this.displayName);
				base = this.source.render(safeWidth)[0]!.trimEnd();
				gap = safeWidth - visibleWidth(base) - visibleWidth(suffix);
			}
			if (!suffix) return showName ? base : line;
			return `${base}${" ".repeat(gap)}${suffix}`;
		});
	}

	invalidate(): void {
		this.source.invalidate();
	}
}

function decorateVisibleModelRows(
	selector: ModelSelectorCompat,
	children: Component[],
	capacity: ModelCapacitySnapshotV2 | undefined,
): string | undefined {
	const filtered = selector.filteredModels ?? [];
	const mixedProviders = new Set(filtered.map((item) => item.provider)).size > 1;
	const selectedIndex = selector.selectedIndex;
	const startIndex = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
			filtered.length - MAX_VISIBLE_MODELS,
		),
	);
	const endIndex = Math.min(startIndex + MAX_VISIBLE_MODELS, filtered.length);
	try {
		const modelMetadata = filtered.map((item) => {
			const capabilities = modelSelectorCapabilities(item);
			return {
				window: capabilities.contextWindow !== undefined && capabilities.contextWindow > 0
					? formatTokenCount(capabilities.contextWindow) : "",
				supportsImages: capabilities.supportsImages,
				displayName: capabilities.displayName,
			};
		});
		// Use the whole filtered list so scrolling does not move the columns.
		const windowWidth = Math.max(0, ...modelMetadata.map((model) => visibleWidth(model.window)));
		const imageWidth = visibleWidth("IMAGE");
		const decorations: Array<() => void> = [];
		for (let index = startIndex; index < endIndex; index++) {
			const childIndex = index - startIndex;
			const child = children[childIndex];
			const item = filtered[index];
			if (!child || !item) throw new Error("model selector row is unavailable");
			const model = modelMetadata[index]!;
			const setRow = prepareModelSelectorRow(child, item, !mixedProviders);
			const displayName = model.displayName ? CAPACITY_THEME.fg("muted", `  ${model.displayName}`) : undefined;
			const image = model.supportsImages ? "IMAGE" : " ".repeat(imageWidth);
			const metadata = model.window
				? `${image} ${" ".repeat(windowWidth - visibleWidth(model.window))}${model.window}`
				: model.supportsImages ? "IMAGE" : "";
			const suffix = formatModelCapacityColored(CAPACITY_THEME, providerCapacity(capacity, item.provider), item.id);
			decorations.push(() => {
				setRow?.();
				if (metadata || suffix || displayName) children[childIndex] = new CapacityModelRow(
					child, metadata ? CAPACITY_THEME.fg("muted", metadata) : undefined, suffix, displayName, setRow,
				);
			});
		}
		// Check the whole visible batch before changing any native row.
		for (const decorate of decorations) decorate();
	} catch (error) {
		return detail(error);
	}
}

function currentTab(selector: ModelSelectorCompat, tabs: readonly TabId[]): TabId | undefined {
	if (selector.scope === "scoped" && tabs.includes("scoped")) return "scoped";
	const currentProvider = selector.currentModel?.provider;
	const current = currentProvider ? `provider:${currentProvider}` as const : undefined;
	return current && tabs.includes(current) ? current : tabs[0];
}

function stateFor(
	selector: ModelSelectorCompat,
	states: WeakMap<object, SelectorState>,
): SelectorState {
	if (!Array.isArray(selector.allModels) || !Array.isArray(selector.scopedModelItems)) {
		throw new Error("selector model arrays are unavailable");
	}
	const tabs = modelSelectorTabs(
		selector.allModels,
		selector.scopedModelItems.length > 0,
	);
	const state = states.get(selector.identity) ?? {
		tabs,
		selected: currentTab(selector, tabs),
	};
	state.tabs = tabs;
	if (!state.selected || !tabs.includes(state.selected)) {
		state.selected = currentTab(selector, tabs);
	}
	states.set(selector.identity, state);
	return state;
}

function modelsForTab(selector: ModelSelectorCompat, tab: TabId | undefined): ModelItem[] {
	if (tab === "scoped") return [...(selector.scopedModelItems ?? [])];
	const provider = providerOf(tab);
	return provider
		? (selector.allModels ?? []).filter((item) => item.provider === provider)
		: [];
}

function modelViewportRows(count: number): number {
	return Math.min(count, MAX_VISIBLE_MODELS) + (count > MAX_VISIBLE_MODELS ? 1 : 0);
}

function modelContentRows(count: number, errorMessage: string | undefined): number {
	const tailRows = errorMessage
		? errorMessage.split("\n").length
		: count === 0
			? 1
			: 2;
	return modelViewportRows(count) + tailRows;
}

/** Blank rows needed to retain the largest tab's native content height. */
function contentPadding(selector: ModelSelectorCompat, state: SelectorState): number {
	const currentCount = selector.filteredModels?.length ?? 0;
	const targetRows = Math.max(
		modelContentRows(currentCount, selector.errorMessage),
		...state.tabs.map((tab) =>
			modelContentRows(modelsForTab(selector, tab).length, selector.errorMessage)),
	);
	return targetRows - modelContentRows(currentCount, selector.errorMessage);
}

function sameModel(left: ModelLike | undefined, right: ModelLike | undefined): boolean {
	return !!left && !!right && left.provider === right.provider && left.id === right.id;
}

/** Keep selection stable when a filter or provider switch rebuilds the slice. */
function narrowVisibleModels(selector: ModelSelectorCompat, state: SelectorState): void {
	if (!Array.isArray(selector.filteredModels)) {
		throw new Error("selector filteredModels is unavailable");
	}
	const previous = selector.filteredModels[selector.selectedIndex]?.model;
	const allowed = new Set(modelsForTab(selector, state.selected));
	const narrowed = selector.filteredModels.filter((item) => allowed.has(item));
	selector.filteredModels = narrowed;
	let selectedIndex = previous
		? narrowed.findIndex((item) => sameModel(item.model, previous))
		: -1;
	if (selectedIndex < 0) {
		selectedIndex = narrowed.findIndex((item) => sameModel(item.model, selector.currentModel));
	}
	selector.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
}

function clearNativeScopeHint(selector: ModelSelectorCompat): void {
	// `scoped` is represented as a tab now, so the old all/scoped rows would be
	// duplicate controls with the wrong Tab hint.
	selector.clearScopeHints();
}

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Install the provider-tab presentation while keeping Pi's native selector. */
export function installProviderTabbedModelSelector(capacitySource?: ModelCapacitySource): () => void {
	declareProbes(PROBES);
	// Selector instances and their selected tabs belong to this installation.
	// A reloaded runtime gets a fresh map; stale selectors can be collected.
	const states = new WeakMap<object, SelectorState>();
	const activeSelectors = new Set<object>();
	let capacitySnapshot: ModelCapacitySnapshotV2 | undefined = capacitySource?.current();
	let watcherSequence = 0;
	const requestCapacity = (): void => capacitySource?.request();
	const unsubscribeCapacity = capacitySource?.subscribe((snapshot) => {
		if (!snapshot || (capacitySnapshot && capacitySnapshot.ownerId === snapshot.ownerId && snapshot.revision < capacitySnapshot.revision)) return;
		capacitySnapshot = snapshot;
		for (const identity of [...activeSelectors]) {
			const selector = modelSelectorCompat(identity);
			if (selector.closed) {
				activeSelectors.delete(identity);
				continue;
			}
			// Capacity changes only decorate the current model rows. Re-running the
			// native filter would reset a non-empty search to its first result.
			selector.updateList();
			selector.requestRender();
		}
	});
	const acquireCapacity = (selector: ModelSelectorCompat, state: SelectorState): void => {
		if (!capacitySource || state.watcherId) return;
		if (!selector.hasLifecycleFields) throw new Error("selector capacity lifecycle fields are unavailable");
		state.watcherId = `cc-style:model-selector:${++watcherSequence}`;
		activeSelectors.add(selector.identity);
		requestCapacity();
		capacitySource.watch(state.watcherId, "acquire");
	};
	const releaseCapacity = (selector: ModelSelectorCompat): void => {
		activeSelectors.delete(selector.identity);
		const state = states.get(selector.identity);
		if (!capacitySource || !state?.watcherId) return;
		capacitySource.watch(state.watcherId, "release");
		state.watcherId = undefined;
	};
	requestCapacity();
	const prototype = modelSelectorPrototype<PatchablePrototype>();
	const previous = prototype[PATCH_STATE] as PatchState | undefined;
	const originalFilter = previous?.owner === PATCH_OWNER
		? previous.originalFilter
		: prototype.filterModels;
	const originalUpdate = previous?.owner === PATCH_OWNER
		? previous.originalUpdate
		: prototype.updateList;
	const originalInput = previous?.owner === PATCH_OWNER
		? previous.originalInput
		: prototype.handleInput;
	const originalDispose = previous?.owner === PATCH_OWNER
		? previous.originalDispose
		: prototype.dispose;
	if (
		typeof originalFilter !== "function"
		|| typeof originalUpdate !== "function"
		|| typeof originalInput !== "function"
		|| typeof originalDispose !== "function"
		|| typeof prototype.setScope !== "function"
	) {
		markBroken("model-selector-tabs.methods", "selector prototype methods are unavailable");
		unsubscribeCapacity?.();
		return () => {};
	}

	const patchedFilter: FilterModels = function providerFilter(query, preferredModel): void {
		let originalModels: ModelItem[] | undefined;
		let called = false;
		try {
			const selector = modelSelectorCompat(this);
			const state = stateFor(selector, states);
			if (!Array.isArray(selector.activeModels)) throw new Error("selector activeModels is unavailable");
			originalModels = selector.activeModels;
			selector.activeModels = modelsForTab(selector, state.selected);
			called = true;
			originalFilter.call(this, query, preferredModel);
			markOk("model-selector-tabs.methods");
		} catch (error) {
			markBroken("model-selector-tabs.fields", detail(error));
			if (!called) originalFilter.call(this, query, preferredModel);
		} finally {
			if (originalModels) modelSelectorCompat(this).activeModels = originalModels;
		}
	};

	const patchedUpdate: UpdateList = function providerList(): void {
		let called = false;
		try {
			const selector = modelSelectorCompat(this);
			const state = stateFor(selector, states);
			acquireCapacity(selector, state);
			narrowVisibleModels(selector, state);
			called = true;
			originalUpdate.call(this);
			const children = selector.listChildren;
			if (!Array.isArray(children)) throw new Error("selector listContainer is unavailable");
			const rowError = decorateVisibleModelRows(selector, children, capacitySnapshot);
			const padding = contentPadding(selector, state);
			if (padding > 0) {
				// Pi places model rows (and its optional scroll indicator) before
				// the selected-model/error tail. Fill there so that tail and border
				// stay anchored when a smaller provider or search result is shown.
				children.splice(
					modelViewportRows(selector.filteredModels?.length ?? 0),
					0,
					new Spacer(padding),
				);
			}
			clearNativeScopeHint(selector);
			if (state.tabs.length > 0) {
				const selectedProvider = providerOf(state.selected)
					?? selector.filteredModels?.[selector.selectedIndex]?.provider;
				const selectedCapacity = providerCapacity(capacitySnapshot, selectedProvider);
				const capacityText = capacitySource && selectedCapacity
					? formatProviderCapacityColored(CAPACITY_THEME, selectedCapacity)
					: undefined;
				const refreshText = selector.refreshStatusMessage
					? CAPACITY_THEME.fg(selector.refreshStatusSuccess ? "success" : "muted", selector.refreshStatusMessage)
					: undefined;
				children.unshift(
					new TabStrip({
						tabs: tabItems(
							state.tabs,
							(tab) => modelsForTab(selector, tab).length,
						),
						selected: state.selected,
						theme: TAB_THEME,
						paddingX: 2,
					}),
					new Spacer(1),
				);
				if (capacityText && selector.listChildren) {
					const nativeRefreshIndex = refreshText
						? selector.listChildren.findIndex((child) =>
							child.render(200).some((line) => line.includes(selector.refreshStatusMessage ?? "\u0000")))
						: -1;
					const combined = new CatalogCapacitySummary(
						refreshText ?? CAPACITY_THEME.fg("muted", "Model capacity"),
						capacityText,
					);
					if (nativeRefreshIndex >= 0) selector.listChildren[nativeRefreshIndex] = combined;
					else selector.listChildren.push(new Spacer(1), combined);
				}
			}
			if (!Array.isArray(selector.children) || selector.children.length === 0) {
				throw new Error("selector root children are unavailable");
			}
			const hintIndex = selector.children.length - 2;
      const nativeHint = selector.children[hintIndex];
      if (!state.nativeKeyHints && nativeHint &&
          stripTerminalSequences(nativeHint.render(1024).join(" ")).includes("to set as default")) {
        state.nativeKeyHints = nativeHint;
        selector.children[hintIndex] = new Spacer(0);
      }
      selector.children[selector.children.length - 1] = new TabHintBorder(state.nativeKeyHints);
			if (rowError) markBroken("model-selector-tabs.fields", rowError);
			else markOk("model-selector-tabs.fields");
			markOk("model-selector-tabs.methods");
		} catch (error) {
			markBroken("model-selector-tabs.fields", detail(error));
			if (!called) originalUpdate.call(this);
		}
	};

	const patchedInput: HandleInput = function providerTabInput(keyData): void {
		const forward = getKeybindings().matches(keyData, "tui.input.tab");
		const backward = matchesKey(keyData, Key.shift("tab"));
		if (!forward && !backward) {
			originalInput.call(this, keyData);
			return;
		}
		const selector = modelSelectorCompat(this);
		const previousSelected = states.get(selector.identity)?.selected;
		try {
			const state = stateFor(selector, states);
			if (state.tabs.length === 0) return;
			state.selected = nextTab(
				tabItems(state.tabs),
				state.selected,
				backward ? -1 : 1,
			);
			selector.selectedIndex = 0;
			const wantedScope = state.selected === "scoped" ? "scoped" : "all";
			if (selector.scope !== wantedScope) {
				if (!selector.setScope(wantedScope)) throw new Error("selector setScope is unavailable");
			} else {
				if (!selector.filter(selector.searchValue)) throw new Error("selector filterModels is unavailable");
			}
			markOk("model-selector-tabs.methods");
		} catch (error) {
			const state = states.get(selector.identity);
			if (state) state.selected = previousSelected;
			markBroken("model-selector-tabs.fields", detail(error));
			originalInput.call(this, keyData);
		}
	};

	const patchedDispose: Dispose = function providerDispose(): void {
		releaseCapacity(modelSelectorCompat(this));
		originalDispose.call(this);
	};

	prototype.filterModels = patchedFilter;
	prototype.updateList = patchedUpdate;
	prototype.handleInput = patchedInput;
	prototype.dispose = patchedDispose;
	prototype[PATCH_STATE] = {
		owner: PATCH_OWNER,
		originalFilter,
		originalUpdate,
		originalInput,
		originalDispose,
		patchedFilter,
		patchedUpdate,
		patchedInput,
		patchedDispose,
	} satisfies PatchState;

	return () => {
		const state = prototype[PATCH_STATE] as PatchState | undefined;
		if (state?.owner !== PATCH_OWNER) return;
		if (prototype.filterModels === state.patchedFilter) prototype.filterModels = state.originalFilter;
		if (prototype.updateList === state.patchedUpdate) prototype.updateList = state.originalUpdate;
		if (prototype.handleInput === state.patchedInput) prototype.handleInput = state.originalInput;
		if (prototype.dispose === state.patchedDispose) prototype.dispose = state.originalDispose;
		for (const identity of [...activeSelectors]) releaseCapacity(modelSelectorCompat(identity));
		unsubscribeCapacity?.();
		delete prototype[PATCH_STATE];
	};
}
