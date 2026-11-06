import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MultiSelectTable, type MultiSelectTableAction } from "pi-li-uikit/multi-select-table";
import type { RewindArchiveRecord } from "../archive.ts";
import {
	currentSessionHistory,
	rewindHistoryDetail,
	rewindHistoryRows,
	type RewindHistoryColumn,
} from "../history-view.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function record(overrides: Partial<RewindArchiveRecord> = {}): RewindArchiveRecord {
	return {
		version: 1,
		id: "rewind-1",
		createdAt: "2026-09-15T12:34:56.000Z",
		sessionId: "session-current",
		sessionFile: "/sessions/current.jsonl",
		originalDigest: "a".repeat(64),
		rewoundDigest: "b".repeat(64),
		originalLeafId: "original",
		logicalRetainedLeafId: "target",
		rewoundLeafId: "target",
		originalEditorText: "",
		rewoundEditorText: "",
		targetEntryId: "target",
		targetRole: "user",
		targetPreview: "message selected for rewind",
		discardedDialogueCount: 2,
		discardedPreview: "the first discarded message has enough text to belong in detail only",
		originalBytes: 4096,
		compressedBytes: 1536,
		recordDir: "/archive/rewind-1",
		archiveFile: "/archive/rewind-1/session.jsonl.gz",
		storedBytes: 2048,
		...overrides,
	};
}

function table(records: readonly RewindArchiveRecord[]) {
	const actions: MultiSelectTableAction<string>[] = [];
	const view = new MultiSelectTable<string, RewindHistoryColumn>({
		tui: {
			terminal: { rows: 24, columns: 80, write() {} },
			requestRender() {},
		} as never,
		theme,
		keybindings: {
			matches(data: string, key: string) {
				return ({
					"tui.select.up": "up",
					"tui.select.down": "down",
					"tui.select.pageUp": "page-up",
					"tui.select.pageDown": "page-down",
					"tui.select.confirm": "enter",
					"tui.select.cancel": "escape",
				} as Record<string, string>)[key] === data;
			},
		} as never,
		title: "Rewind history",
		columns: [
			{ id: "time", header: "Time", minWidth: 19, maxWidth: 19 },
			{ id: "target", header: "Target", minWidth: 6, maxWidth: 6 },
			{ id: "discarded", header: "Discarded", minWidth: 9, maxWidth: 9 },
			{ id: "size", header: "Size", minWidth: 7, maxWidth: 9 },
		],
		rows: rewindHistoryRows(records),
		onAction: (action) => actions.push(action),
		maxVisible: 12,
	});
	view.focused = true;
	return { view, actions };
}

test("history keeps only records from the current session file", () => {
	const current = record();
	const sameIdOtherFile = record({ id: "rewind-2", sessionFile: "/sessions/other.jsonl" });
	const sameFileOtherId = record({ id: "rewind-3", sessionId: "session-other" });
	assert.deepEqual(
		currentSessionHistory(
			[current, sameIdOtherFile, sameFileOtherId],
			"session-current",
			"/sessions/./current.jsonl",
		).map(({ id }) => id),
		["rewind-1"],
	);
});

test("history table aligns columns without ellipses and exposes detail separately", () => {
	const records = [
		record(),
		record({
			id: "rewind-2",
			createdAt: "2026-09-15T13:45:07.000Z",
			targetRole: "assistant",
			discardedDialogueCount: 12,
			compressedBytes: 987,
			targetPreview: "another target",
			discardedPreview: "another discarded message",
		}),
	];
	const { view } = table(records);
	const lines = view.render(80);
	const header = lines.find((line) => line.includes("Time") && line.includes("Discarded"))!;
	const rows = lines.filter((line) => line.includes("2026-09-15"));
	assert.equal(rows.length, 2);
	assert.equal(rows[0]!.indexOf("You"), header.indexOf("Target"));
	assert.equal(rows[1]!.indexOf("AI"), header.indexOf("Target"));
	assert.equal(rows[0]!.indexOf("2", header.indexOf("Discarded")), header.indexOf("Discarded"));
	assert.equal(rows[1]!.indexOf("12", header.indexOf("Discarded")), header.indexOf("Discarded"));
	assert.ok(rows.every((line) => !line.includes("…")), rows.join("\n"));
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	assert.equal(rewindHistoryDetail(records[0]!), "Target: message selected for rewind\n\nFirst discarded: the first discarded message has enough text to belong in detail only");
});

test("history table multi-selects and deletes selected archives in row order", () => {
	const records = [record(), record({ id: "rewind-2" }), record({ id: "rewind-3" })];
	const { view, actions } = table(records);
	view.handleInput(" ");
	view.handleInput("down");
	view.handleInput(" ");
	view.handleInput("d");
	assert.deepEqual(view.selected, ["rewind-1", "rewind-2"]);
	assert.deepEqual(actions, [{ kind: "delete", ids: ["rewind-1", "rewind-2"] }]);

	const all = table(records);
	all.view.handleInput("a");
	assert.deepEqual(all.view.selected, ["rewind-1", "rewind-2", "rewind-3"]);
});
