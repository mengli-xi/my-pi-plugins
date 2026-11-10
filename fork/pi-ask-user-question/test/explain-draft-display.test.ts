import assert from "node:assert/strict";
import test from "node:test";
import { displayLabel } from "../state/i18n-bridge.ts";
import type { QuestionnaireAction } from "../state/key-router.ts";
import { routeKey } from "../state/key-router.ts";
import { sentinelsToAppend } from "../state/row-intent.ts";
import { selectActivePreviewPaneIndex } from "../state/selectors/derivations.ts";
import { selectOptionListProps } from "../state/selectors/projections.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../state/state.ts";
import { type Effect, reduce } from "../state/state-reducer.ts";
import type { QuestionData } from "../tool/types.ts";
import { perTabBinding } from "../view/component-binding.ts";
import { OptionListView } from "../view/components/option-list-view.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";
import { QuestionnairePropsAdapter } from "../view/props-adapter.ts";
import { Editor } from "./doubles/pi-tui.ts";

const RENDER_WIDTH = 80;

/**
 * Mirror of `buildItemsForQuestion` (`ask-user-question.ts`). That module reaches
 * `@juicesharp/rpiv-config`, whose TypeScript sources cannot be stripped from
 * `node_modules`, so the row list is rebuilt here from the same two real helpers.
 */
function buildItems(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) items.push({ kind, label: displayLabel(kind) });
	return items;
}

const storage: QuestionData = {
	question: "Which storage backend should this run record?",
	header: "Storage",
	options: [
		{ label: "Postgres", description: "Relational store with strict schemas." },
		{ label: "SQLite", description: "Single-file store, no server." },
	],
};
const transport: QuestionData = {
	question: "Which transport should this run record?",
	header: "Transport",
	options: [
		{ label: "HTTP", description: "Plain request/response transport." },
		{ label: "WebSocket", description: "Long-lived duplex transport." },
	],
};

/** Row indices inside the item list of a two-option single-select question. */
const ROW_OTHER = 2;
const ROW_EXPLAIN = 4;

const passthroughSelectTheme = {
	selectedText: (s: string) => s,
	description: (s: string) => s,
	scrollInfo: (s: string) => s,
};

const noopPane = {
	setProps: () => {},
	render: () => [],
	invalidate: () => {},
	handleInput: () => {},
};

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		explainInputOpen: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		explainDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
}

/**
 * The inline-editor cases of `QuestionnaireSession.runEffect`
 * (`state/questionnaire-session.ts`), applied to the one shared `inlineInput`
 * the session owns. The remaining effect kinds drive the notes editor, the
 * overlay, or the result and never touch this editor.
 */
function runInlineEffects(editor: Editor, effects: readonly Effect[]): void {
	for (const effect of effects) {
		if (effect.kind === "set_input_buffer") editor.setText(effect.value);
		else if (effect.kind === "clear_input_buffer") editor.setText("");
		else if (effect.kind === "set_input_focused") editor.focused = effect.focused;
	}
}

/**
 * Real reducer + real effects + the real view fan-out, wired to one shared
 * inline `Editor` exactly as `QuestionnaireSession` wires them. Assertions can
 * therefore read what the option list actually renders for the
 * `Type something.` row rather than trusting a reducer field.
 */
class Harness {
	state = initialState();
	readonly editor = new Editor();
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: WrappingSelectItem[][];
	private readonly optionLists: OptionListView[];
	private readonly adapter: QuestionnairePropsAdapter;

	constructor(questions: readonly QuestionData[]) {
		this.questions = questions;
		this.itemsByTab = questions.map((q) => buildItems(q));
		this.optionLists = this.itemsByTab.map(
			(items) => new OptionListView({ items, theme: passthroughSelectTheme }),
		);
		const tabsByIndex = this.optionLists.map((optionList) => ({
			optionList,
			preview: noopPane,
			bodyHeights: () => ({ current: 1, max: 1 }),
		}));
		this.adapter = new QuestionnairePropsAdapter({
			tui: { requestRender: () => {} },
			questions,
			itemsByTab: this.itemsByTab,
			tabsByIndex: tabsByIndex as never,
			inlineInput: this.editor as never,
			globalBindings: [],
			// Same wiring as `buildQuestionnaire`: the active tab's option list is the
			// only one refreshed, and `isActiveTab` is that builder's local predicate.
			perTabBindings: [
				perTabBinding({
					resolve: (tab) => tab.optionList,
					predicate: (s, ctx) => ctx.i === selectActivePreviewPaneIndex(s.currentTab, ctx.totalQuestions),
					select: selectOptionListProps,
				}),
			],
		});
		this.adapter.apply(this.state);
	}

	dispatch(action: QuestionnaireAction): void {
		const result = reduce(this.state, action, { questions: this.questions, itemsByTab: this.itemsByTab });
		this.state = result.state;
		runInlineEffects(this.editor, result.effects);
		this.adapter.apply(this.state);
	}

	/** Mirrors `QuestionnaireSession.handleIgnoreInline`: keystrokes go straight to the shared editor. */
	type(text: string): void {
		this.editor.handleInput(text);
		this.adapter.apply(this.state);
	}

	/** Whatever `routeKey` would hand the reducer for a raw keystroke in the current state. */
	route(data: string): QuestionnaireAction {
		return routeKey(data, this.state, this.runtime());
	}

	rows(tab = this.state.currentTab): string[] {
		return this.optionLists[tab]!.render(RENDER_WIDTH);
	}

	private runtime(): QuestionnaireRuntime {
		const items = this.itemsByTab[this.state.currentTab] ?? [];
		return {
			keybindings: { matches: (data, name) => KEYBINDINGS[name] === data },
			inputBuffer: this.editor.getText(),
			canMoveInputUp: this.editor.getCursor().line > 0,
			canMoveInputDown: this.editor.getCursor().line < this.editor.getLines().length - 1,
			questions: this.questions,
			isMulti: this.questions.length > 1,
			currentItem: items[this.state.optionIndex],
			items,
			collapseKey: "ctrl+]",
		};
	}
}

/** Pi's default bindings for the keys these flows press. */
const KEYBINDINGS: Record<string, string> = {
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\x1b",
	"tui.input.newLine": "\x1b\r",
	"tui.editor.cursorUp": "\x1b[A",
	"tui.editor.cursorDown": "\x1b[B",
	"tui.editor.deleteToLineStart": "\x15",
	"app.editor.external": "\x07",
};

function otherRowText(rows: string[]): string {
	return rows.join("\n");
}

test("closing Explain More hands the shared editor back to an empty custom row", () => {
	const h = new Harness([storage]);
	h.dispatch({ kind: "nav", nextIndex: ROW_EXPLAIN, inputValue: h.editor.getText() });
	h.dispatch({ kind: "explain_open" });
	assert.equal(h.route("L").kind, "ignore", "typing in the Explain panel routes to the shared editor");
	h.type("LEAK_PROBE_TEXT");
	assert.equal(h.editor.getText(), "LEAK_PROBE_TEXT");

	h.dispatch({ kind: "explain_close", value: h.editor.getText() });

	assert.equal(h.editor.getText(), "", "the shared editor must not keep the explain draft");
	assert.equal(h.state.explainDraftsByTab.get(0), "LEAK_PROBE_TEXT");
	assert.equal(h.state.customDraftsByTab.has(0), false);
	const rendered = otherRowText(h.rows());
	assert.match(rendered, /Type something\./);
	assert.doesNotMatch(rendered, /LEAK_PROBE_TEXT/, "the explain draft must not display on the custom row");

	h.dispatch({ kind: "explain_open" });
	assert.equal(h.editor.getText(), "LEAK_PROBE_TEXT", "reopening restores this tab's explain draft");
});

test("an Explain More round trip leaves a pending custom draft on its own row", () => {
	const h = new Harness([storage]);
	h.dispatch({ kind: "nav", nextIndex: ROW_OTHER, inputValue: h.editor.getText() });
	h.type("DRAFT_A_LINE1\nDRAFT_A_LINE2");
	h.dispatch({ kind: "nav", nextIndex: ROW_EXPLAIN, inputValue: h.editor.getText() });
	assert.equal(h.state.customDraftsByTab.get(0), "DRAFT_A_LINE1\nDRAFT_A_LINE2");

	h.dispatch({ kind: "explain_open" });
	h.type("EXPLAIN_PROBE");
	const whileOpen = otherRowText(h.rows());
	assert.match(whileOpen, /DRAFT_A_LINE1/);
	assert.doesNotMatch(whileOpen, /EXPLAIN_PROBE/, "an open Explain panel must not overwrite the custom row");

	h.dispatch({ kind: "explain_close", value: h.editor.getText() });

	assert.equal(h.editor.getText(), "DRAFT_A_LINE1\nDRAFT_A_LINE2");
	assert.equal(h.state.explainDraftsByTab.get(0), "EXPLAIN_PROBE");
	const rendered = otherRowText(h.rows());
	assert.match(rendered, /DRAFT_A_LINE1/);
	assert.match(rendered, /DRAFT_A_LINE2/);
	assert.doesNotMatch(rendered, /EXPLAIN_PROBE/);

	// The custom answer still submits the draft, not the explain text.
	h.dispatch({ kind: "nav", nextIndex: ROW_OTHER, inputValue: h.editor.getText() });
	assert.equal(h.state.inputMode, true);
	assert.equal(h.editor.getText(), "DRAFT_A_LINE1\nDRAFT_A_LINE2");
});

test("an Explain More draft on one question never reaches another question's custom row", () => {
	const h = new Harness([storage, transport]);
	h.dispatch({ kind: "nav", nextIndex: ROW_OTHER, inputValue: h.editor.getText() });
	h.type("Q1_DRAFT");
	// Leaving the input row is what banks the draft — `Tab` is swallowed by the inline
	// editor while it has the keyboard, so this is also the only reachable order in the TUI.
	h.dispatch({ kind: "nav", nextIndex: 0, inputValue: h.editor.getText() });
	h.dispatch({ kind: "tab_switch", nextTab: 1 });
	assert.equal(h.editor.getText(), "");

	h.dispatch({ kind: "nav", nextIndex: ROW_EXPLAIN, inputValue: h.editor.getText() });
	h.dispatch({ kind: "explain_open" });
	h.type("Q2_EXPLAIN");
	h.dispatch({ kind: "explain_close", value: h.editor.getText() });

	assert.equal(h.editor.getText(), "", "question 2 has no custom draft to restore");
	const q2 = otherRowText(h.rows(1));
	assert.match(q2, /Type something\./);
	assert.doesNotMatch(q2, /Q2_EXPLAIN/);
	assert.doesNotMatch(q2, /Q1_DRAFT/);

	assert.equal(h.state.customDraftsByTab.get(0), "Q1_DRAFT");
	assert.equal(h.state.customDraftsByTab.has(1), false);
	assert.equal(h.state.explainDraftsByTab.get(1), "Q2_EXPLAIN");
	assert.equal(h.state.explainDraftsByTab.has(0), false);

	h.dispatch({ kind: "tab_switch", nextTab: 0 });
	h.dispatch({ kind: "nav", nextIndex: ROW_OTHER, inputValue: h.editor.getText() });
	assert.equal(h.editor.getText(), "Q1_DRAFT", "question 1 keeps its own draft");
	assert.match(otherRowText(h.rows(0)), /Q1_DRAFT/);
});
