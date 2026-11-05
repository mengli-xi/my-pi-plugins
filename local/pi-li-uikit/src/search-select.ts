/**
 * search-select — a searchable pick-one screen for the editor panel.
 *
 * Generic building block extracted from the "choose a model" shape: rows of
 * `label [badge]` with the current choice ticked, a filter driven by typing,
 * and an optional Tab-cycled side setting shown in the status line (the way
 * pi's own model selector cycles a mode with Tab). It builds an
 * `EditorPanelScreen`, so any panel can push one as a sub-screen without a
 * second UI slot.
 */

import type {
	EditorPanelActionContext,
	EditorPanelScreen,
	PanelTransition,
} from "pi-li-uikit/editor-panel";
import type { TabStripItem } from "pi-li-uikit/tab-strip";

export interface SearchSelectChoice<Value extends string = string> {
	value: Value;
	/** Row text; the column all rows align on. */
	label: string;
	/** Muted `[badge]` after the label — a provider, a scope, a kind. */
	badge?: string;
	/** Extra text after the badge (overridden by the `current` tick when set). */
	description?: string;
	/** Stable text the search filters on, in place of the rendered row. */
	searchText?: string;
	/** Muted value aligned to the right edge of the selector row. */
	rightText?: string;
	/** Detail for this choice, shown below the list while the row is focused. */
	detail?: string;
	/** Ticked as the value currently in effect. */
	current?: boolean;
	disabled?: boolean;
	/** Category value when this screen uses tabs. */
	tab?: string;
}

export interface SearchSelectScreenOptions<
	Value extends string,
	ScreenId extends string,
> {
	id: ScreenId;
	title: string;
	breadcrumbs: readonly string[];
	choices: readonly SearchSelectChoice<Value>[];
	/** Choice selected when the screen first opens. */
	initialSelected?: Value;
	/** Return a transition to move after picking; return nothing to stay. */
	onPick: (
		value: Value,
		context: EditorPanelActionContext<ScreenId>,
	) => void | PanelTransition<ScreenId> | Promise<void | PanelTransition<ScreenId>>;
	/** On by default; pass false for a navigation-only selector. */
	search?: boolean;
	statusLine?: string;
	onTab?: () => void | Promise<void>;
	/** Tabs filter choices before the screen's text search is applied. */
	tabs?: {
		items: readonly TabStripItem[];
		selected: string | undefined;
		onChange(value: string): void | Promise<void>;
		/** Complete category-navigation hint shown in the bottom divider. */
		hint?: string;
	};
	emptyText?: string;
}

export function searchSelectScreen<Value extends string, ScreenId extends string>(
	options: SearchSelectScreenOptions<Value, ScreenId>,
): EditorPanelScreen<string, ScreenId> {
	const search = options.search ?? true;
	const choices = options.tabs?.selected === undefined
		? options.choices
		: options.choices.filter((choice) => choice.tab === options.tabs?.selected);
	const largestTab = options.tabs
		? Math.max(
			options.tabs.selected === undefined ? options.choices.length : 0,
			...options.tabs.items.map(
				(tab) => options.choices.filter((choice) => choice.tab === tab.value).length,
			),
		)
		: undefined;
	const tabs = options.tabs
		? {
			...options.tabs,
			items: options.tabs.items.map((tab) => ({
				...tab,
				count: tab.count
					?? options.choices.filter((choice) => choice.tab === tab.value).length,
			})),
		}
		: undefined;
	return {
		id: options.id,
		title: options.title,
		breadcrumbs: options.breadcrumbs,
		presentation: "selector",
		search,
		// EditorPanel clamps this to maxVisible. Text filtering and smaller tabs
		// therefore retain the largest category's viewport height.
		fixedItemRows: largestTab === undefined ? undefined : Math.max(1, largestTab),
		statusLine: options.statusLine
			?? (search ? "Type to filter choices." : "Use ↑/↓ to choose."),
		initialSelectedItem: options.initialSelected,
		onTab: options.onTab,
		tabs,
		emptyText: options.emptyText,
		items: choices.map((choice) => ({
			id: choice.value,
			label: choice.label,
			searchText: choice.searchText,
			rightText: choice.rightText,
			detail: choice.detail,
			description: [
				choice.badge ? `[${choice.badge}]` : undefined,
				choice.current ? "✓" : choice.description,
			]
				.filter(Boolean)
				.join(" ") || undefined,
			disabled: choice.disabled,
			onSelect: (context) => options.onPick(choice.value, context),
		})),
	};
}
