import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { inlineRowBudget } from "../presentation.ts";
import type { QuestionnaireResult } from "../tool/types.ts";

const configUrl = new URL("../config.ts", import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
	if (url === configUrl) return { format: "module", shortCircuit: true, source: `
		export const COLLAPSE_KEY_OFF = "off", DEFAULT_COLLAPSE_KEY = "ctrl+]", DEFAULT_NOTES_KEY = "n";
		export const formatKeySpecForDisplay = () => "Ctrl+]", formatNotesKeyForDisplay = x => x;
	` };
	return nextLoad(url, context);
} });
const { QuestionnaireSession } = await import("../state/questionnaire-session.ts");
hook.deregister();

const question = { question: "When should totals refresh?", header: "Refresh", options: [
	{ label: "Live", description: "While open." }, { label: "On reopen", description: "When reopened." },
] };
const keybindings = { matches: (data: string, name: string) => ({
	"tui.select.confirm": "\r", "tui.select.cancel": "\x1b", "tui.input.newLine": "\x1b\r",
	"tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B",
}[name]) === data };
function fixture(rows = 40, multi = false) {
	const questions = multi ? [question, { ...question, question: "When should receipts be sent?", header: "Receipt" }] : [question];
	let result: QuestionnaireResult | undefined;
	const session = new QuestionnaireSession({
		tui: { terminal: { rows, columns: 48 }, requestRender() {} } as never,
		theme: { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as never,
		params: { context: "Choose how checkout updates; Live shows a discount immediately.", questions },
		itemsByTab: questions.map(q => [...q.options.map(option => ({ kind: "option" as const, label: option.label, description: option.description })),
			{ kind: "other", label: "Type something." }, { kind: "chat", label: "Chat about this" }, { kind: "explain", label: "Explain More" }]),
		done: value => { result = value; }, keybindings, editInput: async () => undefined,
		collapseKey: "ctrl+]", notesKey: "n", canReopenWhileHidden: false, rowBudget: inlineRowBudget,
	});
	return { component: session.component, result: () => result };
}

for (const control of ["custom", "explain"] as const) {
	test(`collapsed ${control} input preserves its draft and never edits hidden text`, () => {
		const f = fixture();
		f.component.handleInput(control === "custom" ? "3" : "5");
		f.component.handleInput("draft before collapse");
		f.component.handleInput("\x1d");
		assert.equal(f.component.render(48).length, 1);
		f.component.handleInput("HIDDEN_MUTATION");
		f.component.handleInput("\x1b\r");
		f.component.handleInput("\x1d");
		const rendered = f.component.render(48).join("\n");
		assert.ok(rendered.includes("draft before collapse"), rendered);
		assert.ok(!rendered.includes("HIDDEN_MUTATION"), rendered);
		f.component.handleInput("\r");
		assert.equal(control === "custom" ? f.result()?.answers[0].answer : f.result()?.explain?.notes, "draft before collapse");
	});
}

for (const [rows, multi] of [[11, false], [18, true]] as const) {
	test(`a tall Explain editor follows its real cursor and new text in ${rows} rows (${multi ? "multi" : "single"} question)`, () => {
		const f = fixture(rows, multi);
		f.component.handleInput("5");
		for (let line = 1; line <= 20; line++) {
			f.component.handleInput(`explain-line-${line}`);
			if (line !== 20) f.component.handleInput("\x1b\r");
		}
		const assertVisible = (text: string) => {
			const rendered = f.component.render(48);
			assert.ok(rendered.length <= inlineRowBudget(rows), `height ${rendered.length}`);
			assert.ok(rendered.some(line => line.includes(CURSOR_MARKER)), `cursor was clipped: ${rendered.join("\n")}`);
			assert.ok(rendered.some(line => line.includes(text)), `typed text was clipped: ${rendered.join("\n")}`);
		};
		assertVisible("explain-line-20");
		f.component.handleInput("-continued");
		assertVisible("explain-line-20-continued");
		f.component.handleInput("\x1b[A");
		f.component.handleInput("-moved-cursor");
		assertVisible("-moved-cursor");
	});
}
