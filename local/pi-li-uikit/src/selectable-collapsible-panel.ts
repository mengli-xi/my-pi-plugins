import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	renderCollapsibleRows,
	type CollapsibleRowsOptions,
} from "pi-li-uikit/collapsible-block";
import { panelRightRule } from "pi-li-uikit/panel-footer";
import {
	POPUP_MAX_HEIGHT_RATIO,
	POPUP_MIN_HEIGHT_RATIO,
	ScrollOverlay,
} from "pi-li-uikit/text-panel";

const CHROME_ROWS = 3;

/**
 * Open editor-position panel for a selectable list of collapsible items.
 *
 * The panel owns its frame, item selection and fold state. Consumers only
 * provide item ids plus each item's summary/detail rows. Stable ids preserve
 * selection and expansion while live snapshots replace the list payload.
 */
export abstract class SelectableCollapsiblePanel extends ScrollOverlay {
	private itemIds: string[] = [];
	private selectedId: string | undefined;
	private readonly expandedIds = new Set<string>();
	private revealSelection = true;

	/** Responsive title labels, longest first. */
	protected panelTitleCandidates(): readonly string[] {
		return [this.title()];
	}

	/** Responsive footer labels, longest first. */
	protected abstract panelFooterCandidates(totalLines: number): readonly string[];

	/** Satisfy the viewport base; this panel renders the candidates in its rule. */
	protected footer(totalLines: number): string {
		return this.panelFooterCandidates(totalLines)[0] ?? "";
	}

	/** Replace the selectable identities while retaining surviving UI state. */
	protected setItemIds(ids: readonly string[]): void {
		const next = [...ids];
		const previousIndex = this.selectedItemIndex();
		const selected = this.selectedId;
		const orderChanged = next.length !== this.itemIds.length ||
			next.some((id, index) => id !== this.itemIds[index]);
		this.itemIds = next;
		for (const id of [...this.expandedIds]) {
			if (!next.includes(id)) this.expandedIds.delete(id);
		}
		if (selected && next.includes(selected)) {
			this.activeHeading = next.indexOf(selected);
			if (orderChanged) this.revealSelection = true;
			return;
		}
		const index = Math.max(0, Math.min(previousIndex, next.length - 1));
		this.selectedId = next[index];
		this.activeHeading = next.length > 0 ? index : undefined;
		this.revealSelection = next.length > 0;
	}

	protected isItemExpanded(index: number): boolean {
		const id = this.itemIds[index];
		return id !== undefined && this.expandedIds.has(id);
	}

	protected isItemSelected(index: number): boolean {
		return index === this.selectedItemIndex();
	}

	/** Muted, inset structural row between items; it is never a selectable heading. */
	protected renderItemDivider(width: number): string {
		const safeWidth = Math.max(1, Math.floor(width));
		const inset = safeWidth >= 5 ? 2 : 0;
		return this.theme.fg(
			"borderMuted",
			`${" ".repeat(inset)}${"─".repeat(Math.max(1, safeWidth - inset * 2))}${" ".repeat(inset)}`,
		);
	}

	/** UIKit's selector column plus the shared collapsible two-column grammar. */
	protected renderSelectableRows(
		index: number,
		options: CollapsibleRowsOptions,
		width: number,
	): string[] {
		const rows = renderCollapsibleRows(options, Math.max(1, width - 2));
		const selector = this.isItemSelected(index)
			? this.theme.fg("accent", "→ ")
			: "  ";
		return rows.map((row, rowIndex) => `${rowIndex === 0 ? selector : "  "}${row}`);
	}

	protected override toggleHeading(index: number): void {
		const id = this.itemIds[index];
		if (!id) return;
		this.selectedId = id;
		this.activeHeading = index;
		this.revealSelection = true;
		if (!this.expandedIds.delete(id)) this.expandedIds.add(id);
	}

	protected override prepareViewport(): void {
		if (!this.revealSelection) return;
		this.revealSelection = false;
		const heading = this.headings[this.selectedItemIndex()];
		if (heading === undefined) return;
		if (heading < this.scrollOffset) this.scrollOffset = heading;
		else if (heading >= this.scrollOffset + this.bodyHeight) {
			this.scrollOffset = Math.max(0, heading - this.bodyHeight + 1);
		}
	}

	protected override frameLayout(totalLines: number): { bodyRows: number; topRows: number } {
		const terminalRows = this.tui.terminal.rows;
		const availableRows = Math.max(
			1,
			Math.min(terminalRows, this.availableHeight ?? terminalRows),
		);
		const desiredFloor = Math.max(
			CHROME_ROWS + 1,
			Math.floor(terminalRows * POPUP_MIN_HEIGHT_RATIO),
		);
		const floor = Math.min(availableRows, desiredFloor);
		const ceiling = Math.min(
			availableRows,
			Math.max(floor, Math.floor(terminalRows * POPUP_MAX_HEIGHT_RATIO)),
		);
		const height = Math.min(ceiling, Math.max(floor, totalLines + CHROME_ROWS));
		return { bodyRows: Math.max(1, height - CHROME_ROWS), topRows: 2 };
	}

	protected override chrome(
		visible: readonly string[],
		totalLines: number,
		innerWidth: number,
		safeWidth: number,
	): string[] {
		const lines = [
			panelRightRule(this.theme, safeWidth, this.panelTitleCandidates(), "accent"),
			" ".repeat(safeWidth),
		];
		const thumb = this.thumbRows();
		visible.forEach((line, index) => {
			const grip = thumb && index >= thumb.from && index <= thumb.to
				? this.theme.fg("muted", "█")
				: undefined;
			lines.push(this.openBodyRow(line, innerWidth, grip));
		});
		for (let index = visible.length; index < this.bodyHeight; index++) {
			lines.push(this.openBodyRow("", innerWidth));
		}
		const candidates = this.copyStatus
			? [this.copyStatus]
			: this.panelFooterCandidates(totalLines);
		lines.push(panelRightRule(this.theme, safeWidth, candidates, "accent"));
		return lines;
	}

	override handleInput(data: string): void {
		if (!this.acceptsInput) return;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
			this.moveSelection(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
			this.moveSelection(1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.toggleHeading(this.selectedItemIndex());
			this.tui.requestRender();
			return;
		}
		super.handleInput(data);
	}

	private selectedItemIndex(): number {
		if (this.itemIds.length === 0) return 0;
		const index = this.selectedId === undefined
			? -1
			: this.itemIds.indexOf(this.selectedId);
		return index >= 0 ? index : 0;
	}

	private moveSelection(delta: -1 | 1): void {
		if (this.itemIds.length === 0) return;
		const next = Math.max(
			0,
			Math.min(this.itemIds.length - 1, this.selectedItemIndex() + delta),
		);
		this.selectedId = this.itemIds[next];
		this.activeHeading = next;
		this.revealSelection = true;
		const heading = this.headings[next] ?? 0;
		if (heading < this.scrollOffset) this.scrollOffset = heading;
		else if (heading >= this.scrollOffset + this.bodyHeight) {
			this.scrollOffset = Math.max(0, heading - this.bodyHeight + 1);
		}
	}

	private openBodyRow(line: string, width: number, rightEdge?: string): string {
		const content = truncateToWidth(line, width, "…", true);
		const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
		return `  ${content}${padding} ${rightEdge ?? " "}`;
	}
}

/** Structural theme type retained for callers that expose panel theming. */
export type SelectableCollapsiblePanelTheme = Pick<Theme, "fg">;
