import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
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
import { panelFooterRule } from "pi-li-uikit/panel-footer";
import type { MouseEvent as PanelMouseEvent } from "pi-li-uikit/panel-mouse";
import { panelMouseEvent } from "pi-li-uikit/panel-mouse";

/** One decoded mouse report, forwarded to a panel that lays out its own regions. */
export type InformationPanelMouseEvent = PanelMouseEvent;

/** A point inside the body area, in body rows and panel columns. */
export interface InformationPanelBodyPoint {
	/** Index into the body lines the view returned, scroll included. */
	row: number;
	/** Zero-based column inside the panel's own width. */
	column: number;
}

/** Information panels reserve this many readable body rows whenever space permits. */
export const INFORMATION_PANEL_MIN_BODY_ROWS = 3;
/** No information panel may occupy more than this share of the terminal. */
export const INFORMATION_PANEL_MAX_HEIGHT_RATIO = 0.7;

export type InformationPanelState =
	| { kind: "loading"; detail?: string }
	| { kind: "cached"; detail?: string }
	| { kind: "error"; detail?: string };

export interface InformationPanelView {
	/** Current page name. Breadcrumbs are prepended in the title rule. */
	title: string;
	/** Parent pages, ordered from root to the immediate parent. */
	breadcrumbs?: readonly string[];
	/** Changing this resets the generic reader scroll position. */
	contentKey?: string;
	/**
	 * Standard deferred-data status. `cached` detail may include `Refreshing…`
	 * or `Refresh failed: …`; `loading` and `error` are visible even with no body.
	 */
	state?: InformationPanelState;
	/**
	 * Body lines must already be wrapped for the supplied terminal width.
	 *
	 * `bodyRows` is the row budget for this frame. With `fillsBody` it is the
	 * exact number of rows the shell will draw, so a view that composes its own
	 * regions (columns, an inner viewport) can size them before rendering.
	 * Otherwise it is the previous frame's budget and only a hint.
	 */
	renderBody(width: number, bodyRows: number): readonly string[];
	/**
	 * The view owns the whole body: the shell settles the row budget first,
	 * keeps the frame at that height, and leaves scrolling to the view.
	 */
	fillsBody?: boolean;
	/** Longest hint first; the footer keeps the first candidate that fits. */
	footerHints?: readonly string[];
}

export interface InformationPanelController {
	readonly bodyRows: number;
	readonly scrollOffset: number;
	readonly maxScrollOffset: number;
	scrollTo(offset: number): void;
	reveal(row: number): void;
	close(): void;
	requestRender(): void;
	/** The body cell under a screen point, or undefined outside the body area. */
	bodyPointAt(screenRow: number, screenColumn: number): InformationPanelBodyPoint | undefined;
}

export interface InformationPanelOptions {
	tui: TUI;
	theme: Theme;
	getView(): InformationPanelView;
	onClose(): void;
	/** Returning true consumes the key before the generic reader handles it. */
	onInput?(data: string, controller: InformationPanelController): boolean;
	/**
	 * Returning true consumes one mouse report before the generic reader scrolls.
	 * An outside left press still closes the panel first: that boundary belongs
	 * to the shell and stays the same for every information view.
	 */
	onMouse?(event: InformationPanelMouseEvent, controller: InformationPanelController): boolean;
	/** Starts deferred file/network work only after the loading frame is visible. */
	onFirstRender?(): void;
}

interface ScreenPositionHost extends Component {
	setScreenOrigin(row: number, column: number): void;
}

interface AvailableHeightHost extends Component {
	setAvailableHeight(rows: number): void;
}

/**
 * Shared shell for read-only, editor-position information views.
 *
 * The shell owns the frame, height policy, reader scrolling, focus and outside
 * click dismissal. Domain panels provide only their wrapped body and local
 * navigation state; they never have to recreate this lifecycle.
 */
export class InformationPanel implements Component, Focusable, ScreenPositionHost, AvailableHeightHost {
	readonly wantsMouse = true;
	private readonly options: InformationPanelOptions;
	private _focused = true;
	private availableHeight: number | undefined;
	private bodyRows = 1;
	private scrollOffset = 0;
	private maxScrollOffset = 0;
	private currentContentKey: string | undefined;
	private screenOrigin: { row: number; column: number } | undefined;
	private lastWidth = 0;
	private lastHeight = 0;
	private closed = false;
	private onFirstRender: (() => void) | undefined;

	constructor(options: InformationPanelOptions) {
		this.options = options;
		this.onFirstRender = options.onFirstRender;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	setAvailableHeight(rows: number): void {
		if (!Number.isFinite(rows) || rows < 1) return;
		this.availableHeight = Math.max(1, Math.floor(rows));
	}

	setScreenOrigin(row: number, column: number): void {
		if (!Number.isFinite(row) || !Number.isFinite(column)) return;
		this.screenOrigin = { row: Math.floor(row), column: Math.floor(column) };
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const view = this.options.getView();
		const key = view.contentKey ?? this.title(view, safeWidth);
		if (key !== this.currentContentKey) {
			this.currentContentKey = key;
			this.scrollOffset = 0;
		}

		const state = this.renderState(view.state);
		const fills = view.fillsBody === true;
		// A view that owns the body has to know the row budget before it renders,
		// so the budget is settled from the height policy alone and the frame then
		// keeps that height whatever the view returns.
		const budget = fills
			? Math.max(1, this.maximumRows() - 4 - (state ? 1 : 0))
			: this.bodyRows;
		const body = [...view.renderBody(safeWidth, budget)];
		if (state) body.unshift(state);
		if (body.length === 0) body.push(this.options.theme.fg("muted", "(empty)"));
		const panelRows = fills ? this.maximumRows() : this.panelRows(body.length);
		this.bodyRows = Math.max(1, panelRows - 4);
		this.maxScrollOffset = Math.max(0, body.length - this.bodyRows);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));

		const title = this.title(view, safeWidth);
		const titleLabel = truncateToWidth(` ${title} `, Math.max(1, safeWidth - 4), "…");
		const titleFill = "─".repeat(Math.max(0, safeWidth - 2 - visibleWidth(titleLabel)));
		const accent = (text: string) => this.options.theme.fg("accent", text);
		const visible = body.slice(this.scrollOffset, this.scrollOffset + this.bodyRows);
		const lines = [
			`${accent("──")}${accent(this.options.theme.bold(titleLabel))}${accent(titleFill)}`,
			"",
			...visible.map((line) => truncateToWidth(line, safeWidth, "…", true)),
		];
		for (let index = visible.length; index < this.bodyRows; index++) lines.push("");
		// Keep the footer divider visually separate from the last body row, just
		// like the title divider is separated from the first body row.
		lines.push("");
		lines.push(panelFooterRule(this.options.theme, safeWidth, this.footerHints(view)));

		this.lastWidth = safeWidth;
		this.lastHeight = lines.length;
		const onFirstRender = this.onFirstRender;
		this.onFirstRender = undefined;
		if (onFirstRender) queueMicrotask(onFirstRender);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this._focused || this.closed) return undefined;
		const mouse = panelMouseEvent(event);
		if (mouse) {
			if (mouse.kind === "press" && mouse.button === 0 && this.outside(mouse.row, mouse.col)) this.close();
			else if (this.options.onMouse?.(mouse, this.controller()) !== true && mouse.kind === "wheel") {
				this.scrollTo(this.scrollOffset + mouse.wheel * 3);
			}
		}
		return { handled: true, capture: event.type === "press" && event.button === "left" && !this.closed, render: true };
	}

	handleInput(data: string): void {
		if (!this._focused || this.closed) return;

		if (matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (this.options.onInput?.(data, this.controller()) === true) {
			this.options.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") this.scrollTo(this.scrollOffset - 1);
		else if (matchesKey(data, Key.down) || data === "j") this.scrollTo(this.scrollOffset + 1);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
			this.scrollTo(this.scrollOffset - this.bodyRows);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
			this.scrollTo(this.scrollOffset + this.bodyRows);
		} else if (matchesKey(data, Key.home) || data === "g") this.scrollTo(0);
		else if (matchesKey(data, Key.end) || data === "G") this.scrollTo(this.maxScrollOffset);
		else return;
		this.options.tui.requestRender();
	}

	invalidate(): void {}

	/** Re-render a caller-owned loading, cached, refreshed, or error view. */
	update(): void {
		if (!this.closed) this.options.tui.requestRender();
	}

	dispose(): void {
		this.closed = true;
	}

	/** The tallest frame this panel may draw at the current terminal and slot size. */
	private maximumRows(): number {
		const terminalRows = this.options.tui.terminal?.rows;
		const terminal = Number.isFinite(terminalRows) && terminalRows > 0
			? Math.floor(terminalRows)
			: 1;
		const available = Math.max(1, Math.min(terminal, this.availableHeight ?? terminal));
		return Math.max(1, Math.min(available, Math.floor(terminal * INFORMATION_PANEL_MAX_HEIGHT_RATIO)));
	}

	private panelRows(bodyLineCount: number): number {
		const minimum = INFORMATION_PANEL_MIN_BODY_ROWS + 4;
		return Math.min(this.maximumRows(), Math.max(minimum, bodyLineCount + 4));
	}

	private title(view: InformationPanelView, width: number): string {
		const path = [...(view.breadcrumbs ?? []), view.title].filter((segment) => segment.trim().length > 0);
		if (path.length === 0) return "Information";
		const budget = Math.max(1, width - 4);
		const full = path.join(" > ");
		if (visibleWidth(full) <= budget) return full;
		// Keep the current page visible when the full path no longer fits.
		const current = path[path.length - 1]!;
		const abbreviated = `… > ${current}`;
		return visibleWidth(abbreviated) <= budget ? abbreviated : current;
	}

	private renderState(state: InformationPanelState | undefined): string | undefined {
		if (!state) return undefined;
		const suffix = state.detail?.trim() ? ` · ${state.detail.trim()}` : "";
		if (state.kind === "error") return this.options.theme.fg("error", `Error${suffix}`);
		if (state.kind === "cached") return this.options.theme.fg("muted", `Cached${suffix}`);
		return this.options.theme.fg("muted", `Loading${suffix || "…"}`);
	}

	private footerHints(view: InformationPanelView): readonly string[] {
		return view.footerHints ?? [
			"↑↓/jk scroll · PgUp/PgDn page · g/G top/bottom · Enter/Esc close",
			"↑↓/jk scroll · g/G top/bottom · Enter/Esc close",
			"Enter/Esc close",
			"Esc close",
		];
	}

	private controller(): InformationPanelController {
		const panel = this;
		return {
			get bodyRows() { return panel.bodyRows; },
			get scrollOffset() { return panel.scrollOffset; },
			get maxScrollOffset() { return panel.maxScrollOffset; },
			scrollTo: (offset) => panel.scrollTo(offset),
			reveal: (row) => panel.reveal(row),
			close: () => panel.close(),
			requestRender: () => panel.options.tui.requestRender(),
			bodyPointAt: (row, column) => panel.bodyPointAt(row, column),
		};
	}

	/**
	 * The body starts two rows below the frame's top: the title rule and the
	 * blank row that separates it from the content.
	 */
	private bodyPointAt(screenRow: number, screenColumn: number): InformationPanelBodyPoint | undefined {
		if (!Number.isFinite(screenRow) || !Number.isFinite(screenColumn)) return undefined;
		if (this.lastHeight === 0 || this.lastWidth === 0) return undefined;
		const origin = this.origin();
		const row = Math.floor(screenRow) - origin.row - 2;
		const column = Math.floor(screenColumn) - origin.column;
		if (row < 0 || row >= this.bodyRows) return undefined;
		if (column < 0 || column >= this.lastWidth) return undefined;
		return { row: this.scrollOffset + row, column };
	}

	private scrollTo(offset: number): void {
		if (!Number.isFinite(offset)) return;
		this.scrollOffset = Math.max(0, Math.min(Math.floor(offset), this.maxScrollOffset));
	}

	private reveal(row: number): void {
		if (!Number.isFinite(row)) return;
		const target = Math.max(0, Math.floor(row));
		if (target < this.scrollOffset) this.scrollTo(target);
		else if (target >= this.scrollOffset + this.bodyRows) this.scrollTo(target - this.bodyRows + 1);
	}

	/** The composed frame origin, or the editor-slot fallback before one arrives. */
	private origin(): { row: number; column: number } {
		return this.screenOrigin ?? {
			row: Math.max(0, (this.options.tui.terminal?.rows ?? this.lastHeight) - this.lastHeight),
			column: 0,
		};
	}

	private outside(row: number, column: number): boolean {
		if (this.lastHeight === 0 || this.lastWidth === 0) return false;
		const origin = this.origin();
		return row < origin.row || row >= origin.row + this.lastHeight
			|| column < origin.column || column >= origin.column + this.lastWidth;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.options.onClose();
	}
}

/** Render a metadata line whose key is always less prominent than its value. */
export function renderKeyValue(theme: Pick<Theme, "fg">, key: string, value: string): string {
	return `${theme.fg("muted", `${key}: `)}${value}`;
}

export interface InformationPanelContext {
	mode?: string;
	hasUI: boolean;
	ui: {
		custom<T>(factory: (...args: any[]) => any, options?: unknown): Promise<T>;
	};
}

export interface InformationPanelHost {
	tui: TUI;
	theme: Theme;
	onClose(): void;
}

/** Mount an information panel in Pi's editor slot without replacing the editor. */
export async function showInformationPanelComponent(
	ctx: Pick<InformationPanelContext, "ui">,
	create: (host: InformationPanelHost) => Component,
): Promise<void> {
	const overlay = createEditorOverlayMount();
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		overlay.mount(tui, create({ tui, theme, onClose: done })), overlay.customOptions
	);
}

/** Convenience entry point for simple read-only panels. */
export async function showInformationPanel(
	ctx: InformationPanelContext,
	options: Omit<InformationPanelOptions, "tui" | "theme" | "onClose"> & {
		onCreate?(panel: InformationPanel): void;
	},
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	await showInformationPanelComponent(ctx, (host) => {
		const { onCreate, ...panelOptions } = options;
		const panel = new InformationPanel({ ...host, ...panelOptions });
		onCreate?.(panel);
		return panel;
	});
}
