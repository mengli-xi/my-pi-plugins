import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { EditorPanel } from "./editor-panel.ts";
import { EditorPositionMouseBoundary } from "./panel-mouse.ts";
import { panelFooterRule } from "./panel-footer.ts";
import { searchSelectScreen } from "./search-select.ts";

export interface ProcessPanelItem<ProcessId extends string = string> {
	id: ProcessId;
	name: string;
	kind: string;
	/** Complete semantic status; the detail always spells this one. */
	status: string;
	/**
	 * Shorter wording of the same outcome, used when the shared status column
	 * cannot spell `status`. Omit it when the status has no shorter form.
	 */
	statusShort?: string;
	runtimeMs: number;
	/** Compact command shown at the right edge of the list. */
	command: string;
	/** Complete command/script shown in details; falls back to `command`. */
	script?: string;
	live: boolean;
}

export interface ProcessPanelOutputLine {
	text: string;
	tone?: "text" | "muted" | "warning" | "error";
}

export interface ProcessPanelDetail<ProcessId extends string = string> {
	item: ProcessPanelItem<ProcessId>;
	/** Domain metadata shown above output; it is not counted as process log data. */
	metadata?: readonly ProcessPanelOutputLine[];
	output: readonly ProcessPanelOutputLine[];
	/** Logical line total, including lines outside a retained/tail window. */
	totalLines: number;
}

export interface ProcessPanelOptions<ProcessId extends string> {
	tui: TUI;
	theme: Theme;
	/** A callback is re-read on every render, so a caller can track live state. */
	title?: string | (() => string);
	listHint?: string | (() => string);
	getItems(): readonly ProcessPanelItem<ProcessId>[];
	loadDetail(id: ProcessId): Promise<ProcessPanelDetail<ProcessId>>;
	onStop?(id: ProcessId): void | Promise<void>;
	onClose(): void;
	initialProcessId?: ProcessId;
	/** A process-strip entry closes the panel instead of returning to the list. */
	directDetail?: boolean;
	maxVisible?: number;
}

export type ProcessPanelView = "list" | "detail";

const CONTENT_PADDING = 2;
const LIST_PREFIX_WIDTH = 2;
const LIST_SEPARATOR = " · ";
const COMMAND_GAP = 4;

function oneLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** Shared semantic palette for process states from any process provider. */
export function processStatusTone(status: string): ThemeColor {
	const normalized = oneLine(status).toLocaleLowerCase().replace(/[_-]+/g, " ");
	if (/^(running|starting|stopping)$/.test(normalized)) return "mdLink";
	if (/^(success|succeeded|complete|completed|done|exit 0)$/.test(normalized)) return "success";
	if (/^(timeout|timed out|timedout)(\b|$)/.test(normalized)) return "warning";
	if (
		/^(exit\s+(?!0\b)\S+|failed|failure|error|crashed|killed|stopped|cancelled|canceled)(\b|$)/.test(normalized)
	) return "error";
	return "text";
}

function paintStatus(theme: Theme, status: string): string {
	return theme.fg(processStatusTone(status), oneLine(status));
}

interface ProcessListColumns {
	name: number;
	status: number;
	runtime: number;
}

interface ProcessListLayout {
	columns: ProcessListColumns;
	/** True when every row renders `statusShort` instead of `status`. */
	short: boolean;
}

function listStatus<ProcessId extends string>(
	item: ProcessPanelItem<ProcessId>,
	short: boolean,
): string {
	return oneLine((short ? item.statusShort : undefined) ?? item.status);
}

function widestColumn<ProcessId extends string>(
	items: readonly ProcessPanelItem<ProcessId>[],
	measure: (item: ProcessPanelItem<ProcessId>) => string,
): number {
	return Math.max(1, ...items.map((item) => visibleWidth(measure(item))));
}

function allocateColumns<ProcessId extends string>(
	items: readonly ProcessPanelItem<ProcessId>[],
	width: number,
	short: boolean,
): ProcessListColumns {
	const widths: ProcessListColumns = {
		name: widestColumn(items, (item) => oneLine(item.name)),
		status: widestColumn(items, (item) => listStatus(item, short)),
		runtime: widestColumn(items, (item) => formatProcessRuntime(item.runtimeMs)),
	};
	const floors: ProcessListColumns = {
		name: Math.min(4, widths.name),
		// The short status is the last readable wording of the outcome there is,
		// so it takes its whole width into the allocation instead of a floor the
		// loop may clip below.
		status: short ? widths.status : Math.min(4, widths.status),
		runtime: Math.min(4, widths.runtime),
	};
	const overhead = LIST_PREFIX_WIDTH + LIST_SEPARATOR.length * 2 + COMMAND_GAP;
	const minimumCommandWidth = 8;
	const budget = Math.max(3, width - overhead - minimumCommandWidth);
	while (widths.name + widths.status + widths.runtime > budget) {
		const candidates = (Object.keys(widths) as Array<keyof ProcessListColumns>)
			.filter((key) => widths[key] > floors[key])
			.sort((left, right) => widths[right] - floors[right] - (widths[left] - floors[left]));
		const candidate = candidates[0];
		if (!candidate) break;
		widths[candidate]--;
	}
	return widths;
}

/**
 * One status column serves every row, so the widest status in the record set
 * decides what any row can spell. Allocation happens first: only when it cannot
 * give the full status its own width does the list switch every row to
 * `statusShort` and allocate again — a clipped status is the one thing this
 * column must not show. Items without a shorter form keep the earlier layout.
 */
function processListLayout<ProcessId extends string>(
	items: readonly ProcessPanelItem<ProcessId>[],
	width: number,
): ProcessListLayout {
	const columns = allocateColumns(items, width, false);
	const full = widestColumn(items, (item) => listStatus(item, false));
	if (columns.status >= full) return { columns, short: false };
	if (widestColumn(items, (item) => listStatus(item, true)) >= full) return { columns, short: false };
	return { columns: allocateColumns(items, width, true), short: true };
}

function fitColumn(value: string, width: number): string {
	const clipped = truncateToWidth(oneLine(value), width, "…");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function processListLabel<ProcessId extends string>(
	theme: Theme,
	item: ProcessPanelItem<ProcessId>,
	layout: ProcessListLayout,
): string {
	const columns = layout.columns;
	const status = listStatus(item, layout.short);
	const clippedStatus = truncateToWidth(status, columns.status, "…");
	const paddedStatus = `${paintStatus(theme, clippedStatus)}${" ".repeat(Math.max(0, columns.status - visibleWidth(clippedStatus)))}`;
	return [
		fitColumn(item.name, columns.name),
		paddedStatus,
		fitColumn(formatProcessRuntime(item.runtimeMs), columns.runtime),
	].join(LIST_SEPARATOR) + `${" ".repeat(COMMAND_GAP)}${oneLine(item.command)}`;
}

/**
 * Search reads the stable fields, never the rendered row: a name the columns
 * clipped, or a status the columns replaced, would otherwise change what a
 * query finds when the panel is resized.
 */
function processSearchText<ProcessId extends string>(item: ProcessPanelItem<ProcessId>): string {
	return [item.name, item.id, item.command, item.script]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map(oneLine)
		.join(" ");
}

export function formatProcessRuntime(runtimeMs: number): string {
	const seconds = Math.max(0, Math.floor(runtimeMs / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	return [
		...(hours > 0 ? [`${hours}h`] : []),
		...(hours > 0 || minutes > 0 ? [`${minutes}m`] : []),
		`${remainder}s`,
	].join(" ");
}

function titleRule(theme: Theme, title: string, width: number): string {
	const label = truncateToWidth(` ${title} `, Math.max(1, width - 4), "…");
	const fill = "─".repeat(Math.max(0, width - 2 - visibleWidth(label)));
	return `${theme.fg("accent", "──")}${theme.fg("accent", theme.bold(label))}${theme.fg("accent", fill)}`;
}

function inset(text: string, width: number): string {
	const innerWidth = Math.max(1, width - CONTENT_PADDING * 2);
	return `${" ".repeat(CONTENT_PADDING)}${truncateToWidth(text, innerWidth, "…")}`;
}

function insetRule(theme: Theme, width: number): string {
	return `${" ".repeat(CONTENT_PADDING)}${theme.fg(
		"text",
		"─".repeat(Math.max(1, width - CONTENT_PADDING * 2)),
	)}`;
}

function fieldLabel(theme: Theme, label: string, trailingSpace = true): string {
	return theme.fg("text", theme.bold(`${label}:${trailingSpace ? " " : ""}`));
}

function resolveText(value: string | (() => string) | undefined, fallback: string): string {
	if (typeof value === "function") return value();
	return value ?? fallback;
}

/**
 * Shared process browser. The caller owns process state and actions; this view
 * owns only invocation-local search, selection, output scrolling and follow.
 */
export class ProcessPanel<ProcessId extends string = string> implements Component, Focusable {
	readonly wantsMouse = true;
	private readonly options: ProcessPanelOptions<ProcessId>;
	private readonly list: EditorPanel<"processes">;
	private readonly mouseBoundary: EditorPositionMouseBoundary;
	private _focused = false;
	private currentView: ProcessPanelView = "list";
	private detailId: ProcessId | undefined;
	private detail: ProcessPanelDetail<ProcessId> | undefined;
	private outputOffset = 0;
	private outputRows = 1;
	private follow = true;
	private loading = false;
	private loadQueued = false;
	private confirmation = false;
	private stopping = false;
	private error: string | undefined;
	private availableHeight: number | undefined;
	private directDetail: boolean;
	private disposed = false;
	private listWidth = 80;
	private readonly ticker: ReturnType<typeof setInterval>;

	constructor(options: ProcessPanelOptions<ProcessId>) {
		this.options = options;
		this.mouseBoundary = new EditorPositionMouseBoundary(options.tui);
		this.directDetail = options.directDetail === true;
		this.list = new EditorPanel({
			tui: options.tui,
			theme: options.theme,
			initialScreen: "processes",
			ownsMouseBoundary: false,
			maxVisible: options.maxVisible ?? 12,
			getScreen: () => {
				const items = options.getItems();
				const layout = processListLayout(items, this.listWidth);
				const screen = searchSelectScreen({
					id: "processes" as const,
					title: resolveText(options.title, "Processes"),
					breadcrumbs: [],
					statusLine: resolveText(options.listHint, "Select a process to inspect its output."),
					initialSelected: options.initialProcessId,
					choices: items.map((item) => ({
						value: item.id,
						label: processListLabel(options.theme, item, layout),
						searchText: processSearchText(item),
						detail: oneLine(item.script ?? item.command),
					})),
					emptyText: "No processes in this session.",
					onPick: (id) => {
						void this.openDetail(id);
					},
				});
				return {
					...screen,
					fixedItemRows: Math.max(1, Math.min(options.maxVisible ?? 12, items.length || 1)),
				};
			},
			onClose: () => this.close(),
		});
		this.ticker = setInterval(() => {
			if (this.disposed) return;
			if (this.currentView === "detail" && this.follow) this.refresh();
			else this.options.tui.requestRender();
		}, 1_000);
		this.ticker.unref?.();
		if (options.initialProcessId && this.directDetail) {
			void this.openDetail(options.initialProcessId, true);
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.list.focused = value && this.currentView === "list";
	}

	get view(): ProcessPanelView {
		return this.currentView;
	}

	get selectedId(): ProcessId | undefined {
		return this.currentView === "detail"
			? this.detailId
			: this.list.selectedItemId as ProcessId | undefined;
	}

	get confirmationState(): "stop" | undefined {
		return this.confirmation ? "stop" : undefined;
	}

	get following(): boolean {
		return this.follow;
	}

	setAvailableHeight(rows: number): void {
		if (!Number.isFinite(rows) || rows < 1) return;
		this.availableHeight = Math.max(1, Math.floor(rows));
		this.list.setAvailableHeight(rows);
	}

	setScreenOrigin(row: number, column: number): void {
		this.mouseBoundary.setScreenOrigin(row, column);
	}

	render(width: number): string[] {
		let lines: string[];
		if (this.currentView === "list") {
			this.listWidth = Math.max(20, width);
			lines = this.list.render(width);
		} else {
			lines = this.renderDetail(Math.max(20, width));
		}
		this.mouseBoundary.setFrame(Math.max(1, width), lines.length);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this._focused || this.disposed) return undefined;
		if (this.mouseBoundary.handleMouse(event, () => this.close())) return { handled: true, render: true };
		return { handled: true, render: false };
	}

	handleInput(data: string): void {
		if (!this._focused || this.disposed) return;

		if (this.currentView === "list") {
			this.list.handleInput(data);
			return;
		}
		if (this.confirmation) {
			if (data === "y" || data === "Y") void this.stop();
			else if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
				this.confirmation = false;
				this.options.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
			if (this.directDetail) this.close();
			else {
				this.currentView = "list";
				this.list.focused = this._focused;
				this.options.tui.requestRender();
			}
			return;
		}
		if (data === "x") {
			if (this.currentItem()?.live && this.options.onStop) this.confirmation = true;
		} else if (data === "f") {
			this.follow = !this.follow;
			if (this.follow) {
				this.outputOffset = Number.MAX_SAFE_INTEGER;
				this.refresh();
			}
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.follow = false;
			this.outputOffset = Math.max(0, this.outputOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.follow = false;
			this.outputOffset += 1;
		} else if (matchesKey(data, Key.pageUp)) {
			this.follow = false;
			this.outputOffset = Math.max(0, this.outputOffset - this.outputRows);
		} else if (matchesKey(data, Key.pageDown)) {
			this.follow = false;
			this.outputOffset += this.outputRows;
		} else if (data === "g" || matchesKey(data, Key.home)) {
			this.follow = false;
			this.outputOffset = 0;
		} else if (data === "G" || matchesKey(data, Key.end)) {
			this.follow = false;
			this.outputOffset = Number.MAX_SAFE_INTEGER;
		} else {
			return;
		}
		this.options.tui.requestRender();
	}

	invalidate(): void {
		this.list.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.ticker);
		this.mouseBoundary.dispose();
		this.list.dispose();
	}

	/** Called by a domain owner when process state or output may have changed. */
	refresh(): void {
		if (this.disposed) return;
		if (this.currentView === "detail" && this.detailId && this.follow) {
			void this.load(this.detailId);
		} else {
			this.options.tui.requestRender();
		}
	}

	private async openDetail(id: ProcessId, direct = false): Promise<void> {
		if (this.disposed) return;
		this.currentView = "detail";
		this.detailId = id;
		this.directDetail = direct || this.directDetail;
		this.list.focused = false;
		this.follow = true;
		this.outputOffset = Number.MAX_SAFE_INTEGER;
		this.error = undefined;
		if (this.detail?.item.id !== id) this.detail = undefined;
		this.options.tui.requestRender();
		await this.load(id);
	}

	private async load(id: ProcessId): Promise<void> {
		if (this.loading) {
			this.loadQueued = true;
			return;
		}
		this.loading = true;
		try {
			const detail = await this.options.loadDetail(id);
			if (!this.disposed && this.detailId === id) {
				this.detail = detail;
				this.error = undefined;
			}
		} catch (error) {
			if (!this.disposed && this.detailId === id) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			this.loading = false;
			if (!this.disposed) this.options.tui.requestRender();
			if (this.loadQueued && !this.disposed) {
				this.loadQueued = false;
				const queuedId = this.detailId;
				if (queuedId && this.follow) void this.load(queuedId);
			}
		}
	}

	private renderDetail(width: number): string[] {
		const theme = this.options.theme;
		const item = this.currentItem();
		const output = this.detail?.output ?? [];
		const metadata = this.detail?.metadata ?? [];
		const terminalRows = this.options.tui.terminal?.rows ?? 30;
		const panelRows = Math.max(1, Math.min(terminalRows, this.availableHeight ?? terminalRows));
		if (panelRows < 6) return this.renderMinimalDetail(width, panelRows, item, output);
		let optionalRows = Math.max(0, panelRows - 6);
		const includeRuntime = optionalRows-- > 0;
		const includeScript = optionalRows-- > 0;
		const includeUpperRule = optionalRows-- > 0;
		const includeLowerRule = optionalRows-- > 0;
		const includeTitleGap = optionalRows-- > 0;
		const includeFooterGap = optionalRows-- > 0;
		const metadataRows = Math.min(metadata.length, Math.max(0, optionalRows));
		optionalRows -= metadataRows;
		const fixedRows = 5 + metadataRows + [
			includeRuntime,
			includeScript,
			includeUpperRule,
			includeLowerRule,
			includeTitleGap,
			includeFooterGap,
		].filter(Boolean).length;
		this.outputRows = Math.max(1, Math.min(16, panelRows - fixedRows));
		const maxOffset = Math.max(0, output.length - this.outputRows);
		this.outputOffset = this.follow
			? maxOffset
			: Math.max(0, Math.min(this.outputOffset, maxOffset));
		const visible = output.slice(this.outputOffset, this.outputOffset + this.outputRows);
		const title = item ? `${oneLine(item.name)} · ${oneLine(item.kind)}` : "Process";
		const status = oneLine(item?.status ?? (this.loading ? "loading" : "unknown"));
		const lines = [titleRule(theme, title, width)];
		if (includeTitleGap) lines.push("");
		lines.push(inset(`${fieldLabel(theme, "Status")}${paintStatus(theme, status)}`, width));
		if (includeRuntime) {
			lines.push(inset(`${fieldLabel(theme, "Runtime")}${theme.fg("text", formatProcessRuntime(item?.runtimeMs ?? 0))}`, width));
		}
		if (includeScript) {
			lines.push(inset(`${fieldLabel(theme, "Scripts")}${theme.fg("text", oneLine(item?.script ?? item?.command ?? ""))}`, width));
		}
		for (const line of metadata.slice(0, metadataRows)) {
			lines.push(inset(theme.fg(line.tone ?? "muted", oneLine(line.text)), width));
		}
		lines.push(inset(fieldLabel(theme, "Output", false), width));
		if (includeUpperRule) lines.push(insetRule(theme, width));
		if (this.loading && !this.detail) {
			lines.push(inset(theme.fg("muted", "Loading output…"), width));
		} else if (this.error) {
			lines.push(inset(theme.fg("error", this.error), width));
		} else if (visible.length === 0) {
			lines.push(inset(theme.fg("muted", "No output yet."), width));
		} else {
			for (const line of visible) {
				lines.push(inset(theme.fg(
					line.tone ?? "text",
					line.text,
				), width));
			}
		}
		for (let row = Math.max(1, visible.length); row < this.outputRows; row++) lines.push("");
		if (includeLowerRule) lines.push(insetRule(theme, width));
		lines.push(inset(theme.fg("muted", `${this.detail?.totalLines ?? 0} lines`), width));
		if (includeFooterGap) lines.push("");
		if (this.confirmation) {
			const name = oneLine(item?.name ?? String(this.detailId ?? "process"));
			lines.push(panelFooterRule(theme, width, [
				`Stop '${name}'? y confirm · N cancel`,
				"y confirm · N cancel",
			]));
		} else if (this.stopping) {
			lines.push(panelFooterRule(theme, width, ["Stopping…"]));
		} else {
			const stopHint = item?.live && this.options.onStop ? "x to stop · " : "";
			const closeHint = `Esc ${this.directDetail ? "close" : "back"}`;
			lines.push(panelFooterRule(theme, width, [
				`${stopHint}f to follow newest [${this.follow ? "on" : "off"}] · ${closeHint}`,
				`${stopHint}f follow [${this.follow ? "on" : "off"}] · ${closeHint}`,
				closeHint,
			]));
		}
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	private renderMinimalDetail(
		width: number,
		rows: number,
		item: ProcessPanelItem<ProcessId> | undefined,
		output: readonly ProcessPanelOutputLine[],
	): string[] {
		const theme = this.options.theme;
		const title = item ? `${oneLine(item.name)} · ${oneLine(item.kind)}` : "Process";
		const status = oneLine(item?.status ?? (this.loading ? "loading" : "unknown"));
		const newest = output.at(-1)?.text
			?? (this.loading ? "Loading output…" : this.error ?? "No output yet.");
		const closeHint = `Esc ${this.directDetail ? "close" : "back"}`;
		const content = [
			titleRule(theme, title, width),
			inset(`${fieldLabel(theme, "Status")}${paintStatus(theme, status)}`, width),
			inset(theme.fg("text", newest), width),
			inset(theme.fg("muted", `${this.detail?.totalLines ?? 0} lines`), width),
			panelFooterRule(theme, width, [closeHint]),
		];
		if (rows >= content.length) return content;
		if (rows === 1) return [panelFooterRule(theme, width, [closeHint])];
		return [content[0]!, ...content.slice(Math.max(1, content.length - rows + 1))];
	}

	private currentItem(): ProcessPanelItem<ProcessId> | undefined {
		const current = this.detailId
			? this.options.getItems().find((item) => item.id === this.detailId)
			: undefined;
		return current ?? this.detail?.item;
	}

	private async stop(): Promise<void> {
		const id = this.detailId;
		if (!id || !this.options.onStop || this.stopping) return;
		this.confirmation = false;
		this.stopping = true;
		this.options.tui.requestRender();
		try {
			await this.options.onStop(id);
			this.error = undefined;
			await this.load(id);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.stopping = false;
			if (!this.disposed) this.options.tui.requestRender();
		}
	}

	private close(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.ticker);
		this.mouseBoundary.dispose();
		this.options.onClose();
	}
}
