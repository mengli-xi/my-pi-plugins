import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { EditorPositionMouseBoundary } from "pi-li-uikit/panel-mouse";
import { panelFooterRule } from "pi-li-uikit/panel-footer";
import {
	nextTab,
	renderTabStrip,
	type TabStripItem,
} from "pi-li-uikit/tab-strip";

const MIN_ITEM_DESCRIPTION_GAP = 2;
const MAX_ITEM_DESCRIPTION_GAP = 8;

export type PanelTransition<ScreenId extends string> =
	| { kind: "push"; screen: ScreenId }
	| { kind: "replace"; screen: ScreenId }
	| { kind: "back" }
	| { kind: "close" };

export interface EditorPanelActionContext<ScreenId extends string> {
	signal: AbortSignal;
	transition(transition: PanelTransition<ScreenId>): void;
	query: string;
}

export interface EditorPanelItem<ItemId extends string, ScreenId extends string = string> {
	id: ItemId;
	label: string;
	description?: string;
	/**
	 * Text the search filters on instead of the rendered label and description.
	 * A screen whose rows are formatted to the panel width sets it, so a query
	 * keeps finding the same items when the panel is resized.
	 */
	searchText?: string;
	/** Muted value pinned to the right edge, independent of label width. */
	rightText?: string;
	/** One-line detail shown below selector-style lists while this item is focused. */
	detail?: string;
	disabled?: boolean;
	transition?: PanelTransition<ScreenId>;
	onSelect?: (
		context: EditorPanelActionContext<ScreenId>,
	) => void | PanelTransition<ScreenId> | Promise<void | PanelTransition<ScreenId>>;
}

export interface EditorPanelScreen<
	ItemId extends string = string,
	ScreenId extends string = string,
> {
	id: ScreenId;
	title: string;
	breadcrumbs: readonly string[];
	items: readonly EditorPanelItem<ItemId, ScreenId>[];
	/** Item selected when this screen is first opened. */
	initialSelectedItem?: ItemId;
	emptyText?: string;
	search?: boolean;
	/**
	 * Model-selector-style composition: hint, search input, choices, position,
	 * then the focused item's detail. Ordinary EditorPanel menus keep their
	 * compact layout when omitted.
	 */
	presentation?: "menu" | "selector";
	/** Minimum rows reserved for the item area, clamped to the panel viewport. */
	fixedItemRows?: number;
	/** Extra muted line under the header — live state the screen wants visible. */
	statusLine?: string;
	/** Optional category tabs before results; state remains with the caller. */
	tabs?: {
		items: readonly TabStripItem[];
		selected: string | undefined;
		onChange(value: string): void | Promise<void>;
		hint?: string;
	};
	/** Invoked on Tab. The screen is re-fetched afterward, so cycled state shows. */
	onTab?: () => void | Promise<void>;
}

interface ScreenState {
	selected: number;
	query: string;
	scroll: number;
}

export interface EditorPanelOptions<ScreenId extends string> {
	tui: TUI;
	theme: Theme;
	initialScreen: ScreenId;
	getScreen: (
		id: ScreenId,
		signal: AbortSignal,
	) => EditorPanelScreen<string, ScreenId>;
	onClose: () => void;
	/** False only when a wrapping full panel owns the same mouse boundary. */
	ownsMouseBoundary?: boolean;
	maxVisible?: number;
}

/**
 * Panel text fields receive the same terminal chunk as keyboard shortcuts.
 * Accept only printable text after removing bracketed-paste framing: retaining
 * an unhandled arrow sequence here would turn `\x1b[D` into the visible `[D`.
 */
export function printablePanelInput(data: string): string {
	const unframed = data
		.replace(/^\x1b\[200~/, "")
		.replace(/\x1b\[201~$/, "");
	if (unframed.includes("\x1b")) return "";
	return Array.from(unframed)
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("");
}

/** One invocation-local navigation stack for editor-slot command panels. */
export class EditorPanel<ScreenId extends string> implements Component, Focusable {
	readonly wantsMouse = true;
	private readonly options: EditorPanelOptions<ScreenId>;
	private readonly mouseBoundary: EditorPositionMouseBoundary;
	private readonly controller = new AbortController();
	private readonly stack: ScreenId[];
	private readonly states = new Map<ScreenId, ScreenState>();
	private _focused = false;
	private closed = false;
	private busy = false;
	private error: string | undefined;
	private availableHeight: number | undefined;
	private pageRows = 1;
	private renderedItems = new Map<number, { id: string; disabled: boolean }>();
	private renderedWidth = 0;

	constructor(options: EditorPanelOptions<ScreenId>) {
		this.options = options;
		this.mouseBoundary = new EditorPositionMouseBoundary(options.tui);
		this.stack = [options.initialScreen];
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	get currentScreenId(): ScreenId {
		return this.stack[this.stack.length - 1]!;
	}

	get depth(): number {
		return this.stack.length;
	}

	get selectedItemId(): string | undefined {
		const screen = this.screen();
		const state = this.state(screen.id);
		return this.filtered(screen, state.query)[state.selected]?.id;
	}

	/** Exact item identity from the last successful render, in panel-local coordinates. */
	getRenderedItemAt(row: number, column: number): { readonly id: string; readonly disabled: boolean } | undefined {
		if (this.closed || !Number.isInteger(row) || !Number.isInteger(column) || column < 0 || column >= this.renderedWidth) return undefined;
		const item = this.renderedItems.get(row);
		return item ? { ...item } : undefined;
	}

	setAvailableHeight(rows: number): void {
		if (!Number.isFinite(rows) || rows < 1) return;
		this.availableHeight = Math.max(1, Math.floor(rows));
	}

	setScreenOrigin(row: number, column: number): void {
		if (this.options.ownsMouseBoundary !== false) {
			this.mouseBoundary.setScreenOrigin(row, column);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		this.renderedItems.clear();
		const renderedItems = new Map<number, { id: string; disabled: boolean }>();
		try {
			const screen = this.screen();
			const selectorLayout = screen.presentation === "selector";
			const state = this.state(screen.id);
			const items = this.filtered(screen, state.query);
			state.selected = Math.max(0, Math.min(state.selected, Math.max(0, items.length - 1)));
			const requestedVisible = Math.max(1, this.options.maxVisible ?? 10);
			let fixedRows = 3; // title + blank + footer
			if (this.error) fixedRows += 1;
			if (screen.statusLine) fixedRows += 1;
			if (selectorLayout && (this.error || screen.statusLine)) fixedRows += 1;
			if (screen.tabs && !selectorLayout) fixedRows += 1;
			if (screen.search) fixedRows += selectorLayout ? 2 : 1;
			if (screen.tabs && selectorLayout) fixedRows += 2;
			if (selectorLayout) fixedRows += 4;
			const maxVisible = Math.max(
				1,
				Math.min(
					requestedVisible,
					this.availableHeight === undefined
						? requestedVisible
						: this.availableHeight - fixedRows,
				),
			);
			this.pageRows = maxVisible;
			state.scroll = Math.max(
				0,
				Math.min(state.scroll, Math.max(0, items.length - maxVisible)),
			);
			if (state.selected < state.scroll) state.scroll = state.selected;
			if (state.selected >= state.scroll + maxVisible) {
				state.scroll = state.selected - maxVisible + 1;
			}

			const title = screen.breadcrumbs.length > 0
				? `${screen.breadcrumbs.join(" › ")} › ${screen.title}`
				: screen.title;
			const panelWidth = safeWidth;
			const muted = (text: string) => this.options.theme.fg("muted", text);
			const bodyText = (text: string) => this.options.theme.fg("text", text);
			const accent = (text: string) => this.options.theme.fg("accent", text);

			// The entire titled rule follows the theme accent; content starts after
			// one blank row, matching the other editor-slot UIKit panels.
			const titleLabel = truncateToWidth(` ${title} `, Math.max(1, panelWidth - 4), "…");
			const topFill = Math.max(0, panelWidth - 2 - visibleWidth(titleLabel));
			const lines = [truncateToWidth(
				accent("──") + accent(this.options.theme.bold(titleLabel)) + accent("─".repeat(topFill)),
				panelWidth,
				"…",
			), ""];
			if (this.error) lines.push(this.options.theme.fg("error", this.error));
			if (screen.statusLine) lines.push(truncateToWidth(muted(screen.statusLine), panelWidth, "…"));
			if (selectorLayout && (this.error || screen.statusLine)) lines.push("");
			if (screen.tabs && !selectorLayout) {
				lines.push(truncateToWidth(renderTabStrip({
					tabs: screen.tabs.items,
					selected: screen.tabs.selected,
					theme: {
						active: (text) => this.options.theme.fg("accent", this.options.theme.bold(text)),
						inactive: muted,
						hint: muted,
					},
				}), panelWidth, "…"));
			}
			if (screen.search) {
				lines.push(selectorLayout
					? truncateToWidth(bodyText(`> ${state.query}`), panelWidth, "…")
					: muted(`Search: ${state.query || "type to filter"}`));
				if (selectorLayout) lines.push("");
			}
			if (screen.tabs && selectorLayout) {
				lines.push(truncateToWidth(renderTabStrip({
					tabs: screen.tabs.items,
					selected: screen.tabs.selected,
					theme: {
						active: (text) => this.options.theme.fg("accent", this.options.theme.bold(text)),
						inactive: muted,
						hint: muted,
					},
				}), panelWidth, "…"));
				lines.push("");
			}
			let renderedItemRows = 0;
			if (items.length === 0) {
				lines.push(muted(screen.emptyText ?? "No matching items"));
				renderedItemRows = 1;
			} else {
				const visible = items.slice(state.scroll, Math.min(items.length, state.scroll + maxVisible));
				renderedItemRows = visible.length;
				// One label column across the visible window, so descriptions align.
				const labelWidth = visible.reduce(
					(max, item) => Math.max(max, visibleWidth(item.label)),
					0,
				);
				const descriptionWidth = visible.reduce(
					(max, item) => Math.max(max, visibleWidth(item.description ?? "")),
					0,
				);
				// Spend spare columns on separation before truncating content. The
				// shared value keeps every description aligned while narrowing smoothly.
				const descriptionGap = Math.max(
					MIN_ITEM_DESCRIPTION_GAP,
					Math.min(
						MAX_ITEM_DESCRIPTION_GAP,
						panelWidth - 2 - labelWidth - descriptionWidth,
					),
				);
				for (let index = state.scroll; index < Math.min(items.length, state.scroll + maxVisible); index++) {
					const item = items[index]!;
					const selected = index === state.selected;
					const prefix = selected ? (selectorLayout ? "→ " : "› ") : "  ";
					const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(item.label)));
					const body = `${prefix}${item.label}${pad}`;
					const description = item.description
						? `${" ".repeat(descriptionGap)}${item.description}`
						: "";
					const plainLeft = `${body}${description}`;
					const rightText = item.rightText?.trim() ?? "";
					const fitRight = (left: string, right: string): string => {
						if (!right) return truncateToWidth(left, panelWidth, "…");
						const rightWidth = visibleWidth(right);
						if (rightWidth >= panelWidth) return truncateToWidth(right, panelWidth, "…");
						const fittedLeft = truncateToWidth(left, panelWidth - rightWidth - 1, "…");
						return `${fittedLeft}${" ".repeat(Math.max(1, panelWidth - visibleWidth(fittedLeft) - rightWidth))}${right}`;
					};
					const text = selected || item.disabled
						? fitRight(plainLeft, rightText)
						: fitRight(`${bodyText(body)}${muted(description)}`, rightText ? muted(rightText) : "");
					renderedItems.set(lines.length, { id: item.id, disabled: item.disabled === true });
					lines.push(selected
						? accent(text)
						: item.disabled
							? muted(text)
							: text);
				}
			}
			const fixedItemRows = screen.fixedItemRows === undefined
				? renderedItemRows
				: Math.max(1, Math.min(maxVisible, screen.fixedItemRows));
			for (let row = renderedItemRows; row < fixedItemRows; row++) lines.push("");
			if (selectorLayout) {
				const position = items.length === 0 ? 0 : state.selected + 1;
				lines.push(muted(`  (${position}/${items.length})`), "");
				const selectedItem = items[state.selected];
				const detail = (selectedItem?.detail ?? selectedItem?.label ?? "")
					.replace(/\s+/g, " ")
					.trim();
				lines.push(detail
					? truncateToWidth(muted(`  ${detail}`), panelWidth, "…")
					: "");
				lines.push("");
			}
			const tabHint = screen.tabs ? screen.tabs.hint ?? "Tab/Shift+Tab tabs" : undefined;
			lines.push(panelFooterRule(this.options.theme, panelWidth, this.busy
				? ["Working… · Ctrl+C close", "Ctrl+C close"]
				: [
					...(tabHint ? [
						`${tabHint} · Enter select · Esc back · Ctrl+C close`,
						`${tabHint} · Enter · Esc back`,
					] : []),
					"Enter select · Esc back · Ctrl+C close",
					"Enter · Esc back",
					"Esc back · Ctrl+C close",
					"Esc back",
				]));
			const rendered = lines.map((line) => truncateToWidth(line, safeWidth, "…"));
			this.mouseBoundary.setFrame(safeWidth, rendered.length);
			this.renderedItems = renderedItems;
			this.renderedWidth = safeWidth;
			return rendered;
		} catch (error) {
			const rendered = [
				this.options.theme.fg("error", `Panel render failed: ${error instanceof Error ? error.message : String(error)}`),
				this.options.theme.fg("muted", "Escape to recover"),
			].map((line) => truncateToWidth(line, safeWidth, "…"));
			this.mouseBoundary.setFrame(safeWidth, rendered.length);
			return rendered;
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this._focused || this.closed) return undefined;
		if (this.options.ownsMouseBoundary !== false && this.mouseBoundary.handleMouse(event, () => this.close())) return { handled: true, render: true };
		return { handled: true, render: false };
	}

	handleInput(data: string): void {
		if (!this._focused || this.closed) return;
		this.renderedItems.clear();

		if (matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.back();
			return;
		}
		if (this.busy) return;
		const screen = this.screen();
		const state = this.state(screen.id);
		const items = this.filtered(screen, state.query);
		if (matchesKey(data, Key.up)) {
			state.selected = items.length === 0 ? 0 : (state.selected - 1 + items.length) % items.length;
		} else if (matchesKey(data, Key.down)) {
			state.selected = items.length === 0 ? 0 : (state.selected + 1) % items.length;
		} else if (matchesKey(data, Key.pageUp)) {
			state.selected = Math.max(0, state.selected - this.pageRows);
		} else if (matchesKey(data, Key.pageDown)) {
			state.selected = Math.min(Math.max(0, items.length - 1), state.selected + this.pageRows);
		} else if (matchesKey(data, Key.enter)) {
			const item = items[state.selected];
			if (item && !item.disabled) void this.select(item);
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			if (screen.tabs) {
				const next = nextTab(
					screen.tabs.items,
					screen.tabs.selected,
					matchesKey(data, Key.shift("tab")) ? -1 : 1,
				);
				if (next !== undefined) {
					state.selected = 0;
					state.scroll = 0;
					void Promise.resolve(screen.tabs.onChange(next)).then(() => {
						if (!this.controller.signal.aborted) this.options.tui.requestRender();
					});
				}
			} else if (matchesKey(data, Key.tab) && screen.onTab) {
				void Promise.resolve(screen.onTab()).then(() => {
					if (!this.controller.signal.aborted) this.options.tui.requestRender();
				});
			}
		} else if (screen.search && (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete))) {
			state.query = state.query.slice(0, -1);
			state.selected = 0;
			state.scroll = 0;
		} else if (screen.search) {
			const input = printablePanelInput(data);
			if (input && !input.includes("\x1b")) {
				state.query += input;
				state.selected = 0;
				state.scroll = 0;
			}
		}
		this.options.tui.requestRender();
	}

	transition(transition: PanelTransition<ScreenId>): void {
		if (this.closed) return;
		if (transition.kind === "push") this.stack.push(transition.screen);
		else if (transition.kind === "replace") this.stack[this.stack.length - 1] = transition.screen;
		else if (transition.kind === "back") this.back();
		else this.close();
		this.options.tui.requestRender();
	}

	invalidate(): void { this.renderedItems.clear(); }

	dispose(): void {
		this.close();
	}

	private screen(): EditorPanelScreen<string, ScreenId> {
		return this.options.getScreen(this.currentScreenId, this.controller.signal);
	}

	private state(id: ScreenId): ScreenState {
		let state = this.states.get(id);
		if (!state) {
			const screen = this.screen();
			const initial = screen.initialSelectedItem === undefined
				? -1
				: screen.items.findIndex((item) => item.id === screen.initialSelectedItem);
			state = { selected: Math.max(0, initial), query: "", scroll: 0 };
			this.states.set(id, state);
		}
		return state;
	}

	private filtered(
		screen: EditorPanelScreen<string, ScreenId>,
		query: string,
	): readonly EditorPanelItem<string, ScreenId>[] {
		if (!screen.search || !query) return screen.items;
		const normalized = query.toLocaleLowerCase();
		return screen.items.filter((item) =>
			(item.searchText ?? `${item.label} ${item.description ?? ""}`)
				.toLocaleLowerCase()
				.includes(normalized)
		);
	}

	private async select(item: EditorPanelItem<string, ScreenId>): Promise<void> {
		if (item.transition) {
			this.transition(item.transition);
			return;
		}
		if (!item.onSelect) return;
		this.busy = true;
		this.error = undefined;
		this.options.tui.requestRender();
		try {
			const result = await item.onSelect({
				signal: this.controller.signal,
				transition: (next) => this.transition(next),
				query: this.state(this.currentScreenId).query,
			});
			if (!this.controller.signal.aborted && result) this.transition(result);
		} catch (error) {
			if (!this.controller.signal.aborted) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (!this.controller.signal.aborted) {
				this.busy = false;
				this.options.tui.requestRender();
			}
		}
	}

	private back(): void {
		if (this.stack.length > 1) {
			this.stack.pop();
			this.options.tui.requestRender();
			return;
		}
		this.close();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		if (this.options.ownsMouseBoundary !== false) this.mouseBoundary.dispose();
		this.options.onClose();
	}
}

export interface ShowEditorPanelOptions<ScreenId extends string> {
	initialScreen: ScreenId;
	getScreen: EditorPanelOptions<ScreenId>["getScreen"];
	maxVisible?: number;
}

/** Uses Pi's public command UI slot; Pi restores the editor and focus in finally. */
export async function showEditorPanel<ScreenId extends string>(
	ctx: ExtensionCommandContext,
	options: ShowEditorPanelOptions<ScreenId>,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const overlay = createEditorOverlayMount();
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		overlay.mount(tui, new EditorPanel({ ...options, tui, theme, onClose: done })),
		overlay.customOptions,
	);
}
