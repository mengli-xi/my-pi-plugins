import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { routeKey } from "../state/key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";
const configUrl = new URL("../config.ts", import.meta.url).href;
const hooks = registerHooks({ load(url, context, nextLoad) {
	if (url === configUrl) return { format: "module", shortCircuit: true, source: `
		export const COLLAPSE_KEY_OFF = "off";
		export const DEFAULT_COLLAPSE_KEY = "ctrl+]";
		export const DEFAULT_NOTES_KEY = "n";
		export const formatKeySpecForDisplay = () => "Ctrl+]";
		export const formatNotesKeyForDisplay = key => key;
	` };
	return nextLoad(url, context);
} });
const { HINT_PART_CLEAR, HINT_PART_NAV, HINT_PART_NEW_LINE, HINT_PART_TAB } = await import("../view/dialog-builder.ts");
const { buildHintText } = await import("../view/tab-content-strategy.ts");
hooks.deregister();

const TAB_KEY = "\t";

const question: QuestionData = {
	question: "Which storage backend should this run record?",
	header: "Storage",
	options: [
		{ label: "Postgres", description: "Relational store with strict schemas." },
		{ label: "SQLite", description: "Single-file store, no server." },
	],
};

const items: WrappingSelectItem[] = [
	{ kind: "option", label: "Postgres" },
	{ kind: "option", label: "SQLite" },
	{ kind: "other", label: "Type something." },
	{ kind: "chat", label: "Chat about this" },
	{ kind: "explain", label: "Explain More" },
];

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

function stateWith(overrides: Partial<QuestionnaireState>): QuestionnaireState {
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
		...overrides,
	};
}

function runtimeFor(state: QuestionnaireState): QuestionnaireRuntime {
	return {
		keybindings: { matches: (data, name) => KEYBINDINGS[name] === data },
		inputBuffer: "",
		canMoveInputUp: false,
		canMoveInputDown: false,
		questions: [question, question],
		isMulti: true,
		currentItem: items[state.optionIndex],
		items,
		collapseKey: "ctrl+]",
		notesKey: "n",
	};
}

function locale(name: string): Record<string, string> {
	return JSON.parse(readFileSync(new URL(`../locales/${name}.json`, import.meta.url), "utf8"));
}

const LOCALES = ["de", "en", "es", "fr", "pt-BR", "pt", "ru", "uk", "zh"];

test("a resting question tab advertises Tab, and Tab switches questions", () => {
	const state = stateWith({});
	const hint = buildHintText(question, true, state, "ctrl+]", "n");
	assert.ok(hint.includes(HINT_PART_TAB), hint);
	assert.equal(routeKey(TAB_KEY, state, runtimeFor(state)).kind, "tab_switch");
});

test("the typing footer drops the Tab hint the inline editor swallows", () => {
	const state = stateWith({ optionIndex: 2, inputMode: true });
	const hint = buildHintText(question, true, state, "ctrl+]", "n");

	assert.equal(routeKey(TAB_KEY, state, runtimeFor(state)).kind, "ignore", "Tab reaches the inline editor, not the tab bar");
	assert.ok(!hint.includes(HINT_PART_TAB), `input-mode footer must not promise Tab: ${hint}`);
	// The way out of the input row stays on the line, together with the editing keys.
	assert.ok(hint.includes(HINT_PART_NAV), hint);
	assert.ok(hint.includes(HINT_PART_NEW_LINE), hint);
	assert.ok(hint.includes(HINT_PART_CLEAR), hint);
});

test("the notes footer drops the Tab hint the notes editor swallows", () => {
	const state = stateWith({ notesVisible: true });
	const hint = buildHintText(question, true, state, "ctrl+]", "n");

	assert.equal(routeKey(TAB_KEY, state, runtimeFor(state)).kind, "notes_forward");
	assert.ok(!hint.includes(HINT_PART_TAB), `notes footer must not promise Tab: ${hint}`);
	assert.ok(hint.includes(HINT_PART_NEW_LINE), hint);
});

test("the Explain More panel keeps its own footer without a Tab hint", () => {
	const state = stateWith({ optionIndex: 4, explainInputOpen: true });
	const hint = buildHintText(question, true, state, "ctrl+]", "n");

	assert.equal(routeKey(TAB_KEY, state, runtimeFor(state)).kind, "ignore");
	assert.ok(!hint.includes(HINT_PART_TAB), hint);
});

test("every shipped locale keeps one Tab hint for the state where Tab works", () => {
	for (const name of LOCALES) {
		const strings = locale(name);
		assert.equal(typeof strings["hint.tab"], "string", `${name}.json is missing hint.tab`);
		assert.ok(strings["hint.tab"].length > 0, `${name}.json has an empty hint.tab`);
	}
	assert.equal(locale("en")["hint.tab"], "Tab to switch questions");
	assert.equal(locale("en")["hint.tab"], HINT_PART_TAB, "the English fallback constant must match locales/en.json");
	assert.equal(locale("zh")["hint.tab"], "Tab 切换问题");
});
