import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import { EditorPositionMouseBoundary } from "./panel-mouse.ts";
import { panelFooterRule } from "./panel-footer.ts";

export interface MultiSelectTableColumn<ColumnId extends string = string> {
	id: ColumnId;
	header: string;
	minWidth?: number;
	maxWidth?: number;
	/** Relative share of spare width. Zero keeps the intrinsic width. */
	grow?: number;
}

export interface MultiSelectTableRow<
	RowId extends string = string,
	ColumnId extends string = string,
> {
	id: RowId;
	cells: Readonly<Record<ColumnId, string>>;
	current?: boolean;
	/** Keeps the row activatable and inspectable, but excludes it from selection. */
	selectionDisabled?: boolean;
	/** Explains why selection-only actions are unavailable for this row. */
	selectionDisabledReason?: string;
}

export type MultiSelectTableAction<RowId extends string = string> =
	| { kind: "activate"; id: RowId }
	| { kind: "inspect"; id: RowId }
	| { kind: "delete"; ids: readonly RowId[] }
	| { kind: "cancel" };

export interface MultiSelectTableOptions<
	RowId extends string,
	ColumnId extends string,
> {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	title: string;
	columns: readonly MultiSelectTableColumn<ColumnId>[];
	rows: readonly MultiSelectTableRow<RowId, ColumnId>[];
	onAction(action: MultiSelectTableAction<RowId>): void;
	maxVisible?: number;
	initialRowId?: RowId;
	initialSelectedIds?: readonly RowId[];
	emptyText?: string;
}

const PREFIX_WIDTH = 8;
/** Kept even when columns must shrink, so adjacent values never run together. */
const COLUMN_GAP = 2;

function oneLine(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function fitCell(value: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(oneLine(value), width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function columnWidths<RowId extends string, ColumnId extends string>(
	columns: readonly MultiSelectTableColumn<ColumnId>[],
	rows: readonly MultiSelectTableRow<RowId, ColumnId>[],
	width: number,
): number[] {
	if (columns.length === 0) return [];
	const gaps = COLUMN_GAP * Math.max(0, columns.length - 1);
	const available = Math.max(columns.length, width - PREFIX_WIDTH - gaps);
	const minimums = columns.map((column) => Math.max(1, column.minWidth ?? 1));
	const maximums = columns.map((column) => Math.max(
		minimums[columns.indexOf(column)]!,
		column.maxWidth ?? Number.MAX_SAFE_INTEGER,
	));
	const widths = columns.map((column, index) => {
		const intrinsic = Math.max(
			visibleWidth(oneLine(column.header)),
			...rows.map((row) => visibleWidth(oneLine(row.cells[column.id] ?? ""))),
		);
		return Math.min(maximums[index]!, Math.max(minimums[index]!, intrinsic));
	});

	let total = widths.reduce((sum, candidate) => sum + candidate, 0);
	while (total > available) {
		let candidate = -1;
		let headroom = 0;
		for (let index = 0; index < widths.length; index++) {
			const room = widths[index]! - minimums[index]!;
			if (room > headroom) {
				headroom = room;
				candidate = index;
			}
		}
		if (candidate < 0) break;
		widths[candidate]!--;
		total--;
	}
	// On terminals narrower than the declared minimums, preserve every column
	// header by shrinking the widest remaining column down to one cell.
	while (total > available) {
		let candidate = -1;
		let widest = 1;
		for (let index = 0; index < widths.length; index++) {
			if (widths[index]! > widest) {
				widest = widths[index]!;
				candidate = index;
			}
		}
		if (candidate < 0) break;
		widths[candidate]!--;
		total--;
	}

	let spare = available - total;
	while (spare > 0) {
		const candidates = columns
			.map((column, index) => ({ index, grow: column.grow ?? 0 }))
			.filter(({ index, grow }) => grow > 0 && widths[index]! < maximums[index]!)
			.sort((left, right) => right.grow - left.grow || left.index - right.index);
		if (candidates.length === 0) break;
		for (const { index } of candidates) {
			if (spare === 0) break;
			if (widths[index]! >= maximums[index]!) continue;
			widths[index]!++;
			spare--;
		}
	}
	return widths;
}

/** A stateless-resource table with aligned columns and invocation-local selection. */
export class MultiSelectTable<
	RowId extends string,
	ColumnId extends string,
> implements Component, Focusable {
	readonly wantsMouse = true;
	private readonly options: MultiSelectTableOptions<RowId, ColumnId>;
	private readonly mouseBoundary: EditorPositionMouseBoundary;
	private readonly selectedIds = new Set<RowId>();
	private selectedIndex = 0;
	private scroll = 0;
	private _focused = true;

	constructor(options: MultiSelectTableOptions<RowId, ColumnId>) {
		this.options = options;
		this.mouseBoundary = new EditorPositionMouseBoundary(options.tui);
		const initial = options.initialRowId === undefined
			? -1
			: options.rows.findIndex((row) => row.id === options.initialRowId);
		this.selectedIndex = initial >= 0 ? initial : 0;
		for (const id of options.initialSelectedIds ?? []) {
			const row = options.rows.find((candidate) => candidate.id === id);
			if (row && !row.selectionDisabled) this.selectedIds.add(id);
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	get selected(): readonly RowId[] {
		return this.options.rows
			.filter((row) => this.selectedIds.has(row.id))
			.map((row) => row.id);
	}

	setScreenOrigin(row: number, column: number): void {
		this.mouseBoundary.setScreenOrigin(row, column);
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this._focused) return undefined;
		if (this.mouseBoundary.handleMouse(event, () => this.options.onAction({ kind: "cancel" }))) return { handled: true, render: true };
		return { handled: true, render: false };
	}

	handleInput(data: string): void {
		if (!this._focused) return;
		let handled = true;
		if (this.options.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (this.options.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
			this.move(-(this.options.maxVisible ?? 12));
		} else if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
			this.move(this.options.maxVisible ?? 12);
		} else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = Math.max(0, this.options.rows.length - 1);
		} else if (matchesKey(data, Key.space) || data === " ") {
			this.toggleFocused();
		} else if (data === "a") {
			this.toggleAll();
		} else if (data === "d") {
			const ids = this.deleteTargets();
			if (ids.length > 0) this.options.onAction({ kind: "delete", ids });
		} else if (data === "v") {
			const row = this.focusedRow();
			if (row) this.options.onAction({ kind: "inspect", id: row.id });
		} else if (this.options.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
			const row = this.focusedRow();
			if (row) this.options.onAction({ kind: "activate", id: row.id });
		} else if (
			this.options.keybindings.matches(data, "tui.select.cancel")
			|| matchesKey(data, Key.escape)
			|| matchesKey(data, Key.ctrl("c"))
			|| data === "q"
		) {
			this.options.onAction({ kind: "cancel" });
		} else {
			handled = false;
		}
		if (handled) this.options.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const rows = this.options.rows;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, rows.length - 1)));
		const maxVisible = Math.max(
			1,
			Math.min(this.options.maxVisible ?? 12, Math.max(1, this.options.tui.terminal.rows - 8)),
		);
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - maxVisible)));
		if (this.selectedIndex < this.scroll) this.scroll = this.selectedIndex;
		if (this.selectedIndex >= this.scroll + maxVisible) {
			this.scroll = this.selectedIndex - maxVisible + 1;
		}

		const note = `${rows.length} rows · ${this.selectedIds.size} selected`;
		let noteLabel = ` ${note}`;
		if (visibleWidth(noteLabel) + 7 > safeWidth) noteLabel = "";
		const titleBudget = Math.max(1, safeWidth - 4 - visibleWidth(noteLabel));
		const titleLabel = truncateToWidth(` ${this.options.title} `, titleBudget, "…");
		const titleFill = "─".repeat(Math.max(
			0,
			safeWidth - 2 - visibleWidth(titleLabel) - visibleWidth(noteLabel),
		));
		const top = `${this.options.theme.fg("accent", "──")}${
			this.options.theme.fg("accent", this.options.theme.bold(titleLabel))
		}${this.options.theme.fg("accent", titleFill)}${
			noteLabel ? this.options.theme.fg("muted", noteLabel) : ""
		}`;
		const lines = [truncateToWidth(top, safeWidth, ""), ""];

		const widths = columnWidths(this.options.columns, rows, safeWidth);
		const header = " ".repeat(PREFIX_WIDTH) + this.options.columns
			.map((column, index) => fitCell(column.header, widths[index]!))
			.join(" ".repeat(COLUMN_GAP));
		lines.push(truncateToWidth(this.options.theme.fg("muted", header), safeWidth, ""));

		if (rows.length === 0) {
			lines.push(truncateToWidth(
				`  ${this.options.theme.fg("warning", this.options.emptyText ?? "No rows")}`,
				safeWidth,
				"",
			));
		} else {
			const end = Math.min(rows.length, this.scroll + maxVisible);
			for (let index = this.scroll; index < end; index++) {
				const row = rows[index]!;
				const focused = index === this.selectedIndex;
				const checkbox = row.selectionDisabled
					? this.options.theme.fg("dim", "[-]")
					: this.selectedIds.has(row.id)
						? this.options.theme.fg("accent", "[×]")
						: this.options.theme.fg("muted", "[ ]");
				const current = row.current
					? this.options.theme.fg("success", "●")
					: " ";
				const prefix = `${focused ? this.options.theme.fg("accent", "→") : " "} ${checkbox} ${current} `;
				const plainCells = this.options.columns
					.map((column, columnIndex) => fitCell(row.cells[column.id] ?? "", widths[columnIndex]!))
					.join(" ".repeat(COLUMN_GAP));
				const cells = focused
					? this.options.theme.fg("accent", plainCells)
					: plainCells;
				const body = truncateToWidth(`${prefix}${cells}`, safeWidth, "");
				lines.push(row.selectionDisabled && !focused
						? this.options.theme.fg("muted", body)
						: focused ? body : this.options.theme.fg("text", body));
			}
			if (rows.length > maxVisible) {
				lines.push(this.options.theme.fg("dim", `  ${this.scroll + 1}-${end} of ${rows.length}`));
			}
		}
		const focusedRow = this.focusedRow();
		const selectionStatus = focusedRow?.selectionDisabled
			? `Cannot select for deletion: ${oneLine(focusedRow.selectionDisabledReason ?? "selection is unavailable")}`
			: "Space selects rows for deletion; Enter opens the focused row";
		lines.push("", truncateToWidth(
			`  ${this.options.theme.fg(focusedRow?.selectionDisabled ? "warning" : "muted", selectionStatus)}`,
			safeWidth,
			"",
		));
		lines.push(panelFooterRule(this.options.theme, safeWidth, [
			"↑↓ move · Space select · a all · d delete · Enter open · v inspect · Esc close",
			"↑↓ move · Space select · d delete · Enter open · Esc close",
			"↑↓ · Space select · Enter open · Esc close",
			"Enter open · Esc close",
			"Esc close",
		]));
		const rendered = lines.map((line) => truncateToWidth(line, safeWidth, ""));
		this.mouseBoundary.setFrame(safeWidth, rendered.length);
		return rendered;
	}

	dispose(): void {
		this.mouseBoundary.dispose();
	}

	private focusedRow(): MultiSelectTableRow<RowId, ColumnId> | undefined {
		return this.options.rows[this.selectedIndex];
	}

	private move(delta: number): void {
		if (this.options.rows.length === 0) return;
		this.selectedIndex = Math.max(
			0,
			Math.min(this.options.rows.length - 1, this.selectedIndex + delta),
		);
	}

	private toggleFocused(): void {
		const row = this.focusedRow();
		if (!row || row.selectionDisabled) return;
		if (this.selectedIds.has(row.id)) this.selectedIds.delete(row.id);
		else this.selectedIds.add(row.id);
	}

	private toggleAll(): void {
		const selectable = this.options.rows.filter((row) => !row.selectionDisabled);
		const allSelected = selectable.length > 0 && selectable.every((row) => this.selectedIds.has(row.id));
		if (allSelected) {
			for (const row of selectable) this.selectedIds.delete(row.id);
		} else {
			for (const row of selectable) this.selectedIds.add(row.id);
		}
	}

	private deleteTargets(): RowId[] {
		const selected = this.selected;
		if (selected.length > 0) return [...selected];
		const row = this.focusedRow();
		return row && !row.selectionDisabled ? [row.id] : [];
	}
}
