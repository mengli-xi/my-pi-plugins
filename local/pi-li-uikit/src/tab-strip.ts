/** A reusable, state-external tab strip for TUI selectors. */

import {
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";

export interface TabStripItem<Value extends string = string> {
	value: Value;
	label: string;
	/** Stable total for this category; omitted when the consumer has no count. */
	count?: number;
	disabled?: boolean;
}

export interface TabStripTheme {
	active(text: string): string;
	inactive(text: string): string;
	hint(text: string): string;
}

export interface TabStripOptions<Value extends string = string> {
	tabs: readonly TabStripItem<Value>[];
	selected: Value | undefined;
	theme: TabStripTheme;
	hint?: string;
	paddingX?: number;
}

/** Pick the adjacent enabled tab, wrapping at both ends. */
export function nextTab<Value extends string>(
	tabs: readonly TabStripItem<Value>[],
	selected: Value | undefined,
	direction: 1 | -1,
): Value | undefined {
	const enabled = tabs.filter((tab) => !tab.disabled);
	if (enabled.length === 0) return undefined;
	const current = enabled.findIndex((tab) => tab.value === selected);
	const start = current >= 0 ? current : direction > 0 ? -1 : 0;
	const index = (start + direction + enabled.length) % enabled.length;
	return enabled[index]?.value;
}

/** Render text only; consumers embedding the strip in another component use this. */
export function renderTabStrip<Value extends string>(
	options: TabStripOptions<Value>,
): string {
	const labels = options.tabs.map((tab) => {
		const text = tab.count === undefined ? tab.label : `${tab.label} (${tab.count})`;
		const active = tab.value === options.selected;
		// Keep every tab's footprint stable: the inactive spaces reserve the two
		// columns occupied by the active tab's brackets. Switching tabs therefore
		// changes only paint/markers, never the position of any following content.
		const label = active ? `[${text}]` : ` ${text} `;
		return active
			? options.theme.active(label)
			: options.theme.inactive(label);
	});
	const hint = options.hint ? `  · ${options.theme.hint(options.hint)}` : "";
	return `${labels.join("  ")}${hint}`;
}

/** Render a keyboard hint woven into a full-width divider. */
export function renderTabHintDivider(
	hint: string,
	width: number,
	paint: (text: string) => string = (text) => text,
): string {
	const safeWidth = Math.max(1, width);
	const label = ` ${hint} `;
	const plain = visibleWidth(label) + 2 <= safeWidth
		? `──${label}${"─".repeat(safeWidth - visibleWidth(label) - 2)}`
		: truncateToWidth(hint, safeWidth, "…");
	return paint(plain);
}

/**
 * Presentation component whose state remains with its owner.
 *
 * Recreate it or provide a new options snapshot when tabs change; no module or
 * cross-extension state is retained here.
 */
export class TabStrip<Value extends string = string> implements Component {
	private readonly options: TabStripOptions<Value>;

	constructor(options: TabStripOptions<Value>) {
		this.options = options;
	}

	render(width: number): string[] {
		return new Text(
			renderTabStrip(this.options),
			this.options.paddingX ?? 1,
			0,
		).render(width);
	}

	invalidate(): void {}
}
