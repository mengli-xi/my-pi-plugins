import { resolve } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { RewindArchiveRecord } from "./archive.ts";

const UNSAFE_TERMINAL_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function safeText(value: string): string {
	return stripTerminalSequences(value).replace(UNSAFE_TERMINAL_TEXT, "�");
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

export function historyTimestamp(createdAt: string): string {
	const value = new Date(createdAt);
	return [
		value.getFullYear(),
		twoDigits(value.getMonth() + 1),
		twoDigits(value.getDate()),
	].join("-") + " " + [
		twoDigits(value.getHours()),
		twoDigits(value.getMinutes()),
		twoDigits(value.getSeconds()),
	].join(":");
}

export function historySize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function currentSessionHistory(
	records: readonly RewindArchiveRecord[],
	sessionId: string,
	sessionFile: string,
): RewindArchiveRecord[] {
	const canonicalFile = resolve(sessionFile);
	return records.filter((record) =>
		record.sessionId === sessionId && resolve(record.sessionFile) === canonicalFile
	);
}

export type RewindHistoryColumn = "time" | "target" | "discarded" | "size";

export function rewindHistoryRows(records: readonly RewindArchiveRecord[]): Array<{
	id: string;
	cells: Record<RewindHistoryColumn, string>;
}> {
	return records.map((record) => ({
		id: record.id,
		cells: {
			time: historyTimestamp(record.createdAt),
			target: record.targetRole === "user" ? "You" : "AI",
			discarded: String(record.discardedDialogueCount),
			size: historySize(record.compressedBytes),
		},
	}));
}

export function rewindHistoryDetail(record: RewindArchiveRecord): string {
	const target = safeText(record.targetPreview);
	const discarded = safeText(record.discardedPreview);
	return discarded
		? `Target: ${target}\n\nFirst discarded: ${discarded}`
		: `Target: ${target}\n\nNo later dialogue discarded`;
}

