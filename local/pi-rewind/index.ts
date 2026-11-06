import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { showEditorPanel } from "pi-li-uikit/editor-panel";
import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { MultiSelectTable, type MultiSelectTableAction } from "pi-li-uikit/multi-select-table";
import { searchSelectScreen } from "pi-li-uikit/search-select";
import { showTextPanel } from "pi-li-uikit/text-panel";
import { hasAnswerContent, startHasAnswerContent } from "./answer-content.ts";
import { collectDialogueChoices, collectRewindChoices, oneLine, rewindEditorContent, type RewindChoice } from "./conversation.ts";
import { editorSourceText, restoredEditorSource } from "./editor-image-source.ts";
import { installRewindEditor, RewindSubmissionGuard } from "./editor-wrapper.ts";
import {
	PendingConnectionRewindState,
	type PendingConnectionRewindRequest,
} from "./pending-connection.ts";
import {
	buildPrunedJsonl,
	CheckedSessionRewriteUnsupportedError,
	readSessionSnapshot,
	sessionBytesDigest,
	SessionRewriteConflictError,
	stageSessionRewrite,
	type SessionRewrite,
} from "./session-file.ts";
import { traceRewind } from "./trace.ts";
import {
	RewindArchive,
	type RewindArchiveRecord,
} from "./archive.ts";
import { join } from "node:path";
import {
	currentSessionHistory,
	rewindHistoryDetail,
	rewindHistoryRows,
	type RewindHistoryColumn,
} from "./history-view.ts";

const COMMAND = "rewind";
const PENDING_CONNECTION_ARG = "--pending-connection";
const UNDO_ARG = "undo";
const HISTORY_ARG = "history";

const REWIND_ARGUMENT_COMPLETIONS = [
	{ value: UNDO_ARG, label: UNDO_ARG, description: "Restore the latest rewind for this session" },
	{ value: HISTORY_ARG, label: HISTORY_ARG, description: "Browse archived rewinds for this session" },
] as const;

export function rewindArgumentCompletions(prefix: string): Array<{
	value: string;
	label: string;
	description: string;
}> | null {
	const query = prefix.trim().toLowerCase();
	const matches = REWIND_ARGUMENT_COMPLETIONS.filter(({ value }) =>
		query !== value && value.startsWith(query)
	);
	return matches.length > 0 ? [...matches] : null;
}

interface RewindUndoSnapshot {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly backupFile: string;
	readonly originalDigest: string;
	readonly rewoundDigest: string;
	readonly originalLeafId: string;
	readonly logicalRetainedLeafId: string | null;
	readonly rewoundLeafId: string | null;
	readonly originalEditorText: string;
	readonly rewoundEditorText: string;
	readonly targetEntryId: string;
	readonly targetRole: "user" | "assistant";
	readonly targetText: string;
	readonly originalJsonl?: string;
	readonly rewoundJsonl?: string;
	readonly discardedDialogueCount: number;
	readonly discardedPreview: string;
	readonly rewrite: SessionRewrite;
	readonly archiveRecord?: RewindArchiveRecord;
}

interface RewindUndoState {
	current?: RewindUndoSnapshot;
}

export type TrashBackup = (backupFile: string) => Promise<boolean>;

/**
 * Move the recovery sibling to the system Trash, reporting whether it went.
 * A refusal is surfaced rather than swallowed: the backup stays on disk and the
 * warning names it. Tests drive both outcomes through {@link RewindDependencies}
 * rather than through whatever the running machine's trash command allows.
 */
const trashBackup: TrashBackup = async (backupFile) => {
	const command = process.platform === "darwin" ? "/usr/bin/trash" : "trash";
	return new Promise((resolve) => {
		const child = spawn(command, [backupFile], { stdio: "ignore", shell: false });
		child.once("error", () => resolve(false));
		child.once("exit", (code) => resolve(code === 0));
	});
};

/** Pi loads the extension with no second argument, so this is the shipped behavior. */
export interface RewindDependencies {
	trashBackup?: TrashBackup;
	/** @internal Disable or redirect persistence in deterministic tests. */
	archive?: RewindArchive | false;
}

/**
 * Pi hands extensions a ReadonlySessionManager view of the live SessionManager.
 * Rewind rewrites that session's own file, so it has to rebind the manager to
 * the pruned bytes; otherwise memory keeps the discarded branch and later
 * appends orphan themselves against entries the file no longer holds.
 * `npm run check-internals` verifies the method after a Pi upgrade.
 */
interface LiveSessionFileControl {
	setSessionFile(sessionFile: string): void;
}

interface LiveSessionBranchControl extends LiveSessionFileControl {
	branch(entryId: string): void;
	resetLeaf(): void;
}

export function reloadPrunedSessionFile(
	manager: LiveSessionFileControl,
	sessionFile: string,
): void {
	if (typeof manager.setSessionFile !== "function") {
		throw new Error("Rewind requires SessionManager.setSessionFile to prune a live session");
	}
	manager.setSessionFile(sessionFile);
}

function pointSessionLeaf(manager: LiveSessionBranchControl, leafId: string | null): void {
	if (leafId === null) {
		if (typeof manager.resetLeaf !== "function") throw new Error("Rewind undo requires SessionManager.resetLeaf");
		manager.resetLeaf();
		return;
	}
	if (typeof manager.branch !== "function") throw new Error("Rewind undo requires SessionManager.branch");
	manager.branch(leafId);
}

export function restoreEditorSource(
	ui: Pick<ExtensionCommandContext["ui"], "setEditorText" | "getEditorText">,
	source: string,
): { restoredImages: boolean } {
	ui.setEditorText(source);
	const fallback = rewindEditorContent(source);
	if (!fallback.hasImages) return { restoredImages: false };
	const restored = restoredEditorSource(source);
	if (!restored.handled) {
		ui.setEditorText(fallback.text);
		return { restoredImages: false };
	}
	return { restoredImages: /\[Image #\d+\]/u.test(restored.editorText) };
}

/**
 * Rewind in place: navigate the live branch, then prune the file behind it.
 *
 * `ctx.navigateTree()` is Pi's own `/tree` move. It repoints the leaf, rebuilds
 * the agent context and the transcript, and gives extensions their
 * `session_before_tree` veto and `session_tree` notification — all without
 * tearing down the runtime. Everything this then deletes from the JSONL is
 * exactly what the navigation already dropped off the active path, so no
 * extension sees less than a plain `/tree` leaves it with. The previous
 * `switchSession()` replacement rebuilt services, re-registered every
 * extension and re-ran session bootstrap, which is the reload users saw.
 */
async function rewindTo(
	ctx: ExtensionCommandContext,
	choice: RewindChoice,
	submissions: RewindSubmissionGuard,
): Promise<RewindUndoSnapshot | undefined> {
	submissions.begin();
	let snapshot: RewindUndoSnapshot | undefined;
	try {
		snapshot = await rewindWithSubmissionHeld(ctx, choice, submissions);
		return snapshot;
	} finally {
		submissions.finish(snapshot !== undefined);
	}
}

async function rewindWithSubmissionHeld(
	ctx: ExtensionCommandContext,
	choice: RewindChoice,
	submissions: RewindSubmissionGuard,
): Promise<RewindUndoSnapshot | undefined> {
	if (choice.role !== "user") throw new Error("Rewind targets must be user messages");
	traceRewind("rewind.begin", { role: choice.role });
	const manager = ctx.sessionManager;
	const sessionFile = manager.getSessionFile();
	const header = manager.getHeader();
	if (!sessionFile || !header) throw new Error("Rewind requires a persisted Pi session");
	const control = manager as unknown as LiveSessionFileControl;
	if (typeof control.setSessionFile !== "function") {
		throw new Error("Rewind requires SessionManager.setSessionFile before changing the session");
	}
	// navigateTree() refuses to move a live branch, and the picker can be
	// reached mid-stream through the steering path.
	if (!ctx.isIdle()) {
		ctx.abort();
		await ctx.waitForIdle();
	}
	// A picker holds a snapshot of the branch. Another rewind or /tree move
	// may have removed its target while the picker (or waitForIdle) was open.
	if (!manager.getBranch().some((entry) => entry.id === choice.entryId)) {
		ctx.ui.notify("The selected message is no longer on the current path; nothing was rewound.", "info");
		return undefined;
	}
	const originalLeafId = manager.getLeafId();
	if (originalLeafId === null) throw new Error("Rewind requires a current session leaf");
	const originalEditorText = editorSourceText(ctx.ui.getEditorText());
	const originalChoices = collectDialogueChoices(manager.getBranch());

	traceRewind("rewind.navigate_start");
	const navigated = await ctx.navigateTree(choice.entryId);
	traceRewind("rewind.navigate_done", { cancelled: navigated.cancelled });
	if (navigated.cancelled) {
		ctx.ui.notify("Rewind was cancelled; the session was left unchanged.", "warning");
		return undefined;
	}
	// TUI navigateTree already restored the prompt. Preserve any edits made
	// while the file rewrite is awaiting I/O rather than overwriting them later.
	const navigationEditorText = ctx.ui.getEditorText();

	traceRewind("rewind.stage_start");
	let rewrite: Awaited<ReturnType<typeof stageSessionRewrite>>;
	let prunedJsonl: string;
	try {
		// The leaf is the retained path by construction after the navigation,
		// so anything a session_tree handler appended stays.
		prunedJsonl = buildPrunedJsonl(header, manager.getBranch(), manager.getEntries());
		rewrite = await stageSessionRewrite(sessionFile, prunedJsonl);
	} catch (error) {
		if (error instanceof SessionRewriteConflictError) {
			ctx.ui.notify("The session changed during rewind; newer state was kept and history was not pruned.", "warning");
			return undefined;
		}
		try {
			const restored = await ctx.navigateTree(originalLeafId);
			if (restored.cancelled) throw new Error("Rewind recovery navigation was cancelled");
		} catch (recoveryError) {
			throw new AggregateError([error, recoveryError], "Rewind preparation and navigation recovery both failed");
		}
		throw error;
	}
	traceRewind("rewind.stage_done");

	try {
		reloadPrunedSessionFile(control, rewrite.sessionFile);
	} catch (error) {
		try {
			await rewrite.rollback({ expectedCurrentDigest: sessionBytesDigest(prunedJsonl) });
		} catch (rollbackError) {
			const errors = [error, rollbackError];
			try {
				reloadPrunedSessionFile(control, sessionFile);
			} catch (rebindError) {
				errors.push(rebindError);
			}
			throw new AggregateError(errors, `Rewind and file rollback failed; inspect the current session and recovery backup path: ${rewrite.backupFile}`);
		}
		try {
			reloadPrunedSessionFile(control, sessionFile);
			const restored = await ctx.navigateTree(originalLeafId);
			if (restored.cancelled) throw new Error("Rewind recovery navigation was cancelled");
		} catch (recoveryError) {
			throw new AggregateError([error, recoveryError], "Original session bytes were restored, but runtime/navigation recovery failed");
		}
		throw error;
	}
	traceRewind("rewind.reload_done");

	const editorUnchanged = !submissions.hasEdits() && ctx.ui.getEditorText() === navigationEditorText;
	const editorRestore = choice.editorText === undefined || !editorUnchanged
		? { restoredImages: false }
		: restoreEditorSource(ctx.ui, choice.editorText);
	traceRewind("rewind.editor_restored");
	traceRewind("rewind.snapshot_start");
	const originalBytes = await readSessionSnapshot(rewrite.backupFile);
	const rewoundBytes = await readSessionSnapshot(sessionFile);
	traceRewind("rewind.snapshot_done");
	const targetIndex = originalChoices.findIndex((candidate) => candidate.entryId === choice.entryId);
	const discardedChoices = targetIndex < 0
		? []
		: originalChoices.slice(targetIndex);
	const snapshot = {
		sessionId: manager.getSessionId(),
		sessionFile,
		backupFile: rewrite.backupFile,
		originalDigest: sessionBytesDigest(originalBytes),
		rewoundDigest: sessionBytesDigest(rewoundBytes),
		originalLeafId,
		logicalRetainedLeafId: choice.retainThroughId,
		rewoundLeafId: manager.getLeafId(),
		originalEditorText,
		rewoundEditorText: editorUnchanged && choice.editorText !== undefined
			? choice.editorText : editorSourceText(ctx.ui.getEditorText()),
		targetEntryId: choice.entryId,
		targetRole: choice.role,
		targetText: choice.text,
		originalJsonl: originalBytes,
		rewoundJsonl: rewoundBytes,
		discardedDialogueCount: discardedChoices.length,
		discardedPreview: discardedChoices.at(0)?.text ?? "",
		rewrite,
	} satisfies RewindUndoSnapshot;
	const suffix = choice.hasImages
		? editorRestore.restoredImages
			? " The image remains attached and can be edited or resubmitted."
			: " The image could not be reattached; paste it again before resubmitting."
		: "";
	ctx.ui.notify(
		rewrite.supportsCheckedReplacement
			? `Rewound to the selected ${choice.role} message. Run /rewind undo before this session changes to restore it.${suffix}`
			: `Rewound to the selected ${choice.role} message. This filesystem cannot provide a race-safe undo point.${suffix}`,
		rewrite.supportsCheckedReplacement ? "info" : "warning",
	);
	traceRewind("rewind.done");
	return snapshot;
}

async function retireUndoSnapshot(snapshot: RewindUndoSnapshot, trash: TrashBackup): Promise<boolean> {
	if (snapshot.archiveRecord) {
		try {
			await snapshot.rewrite.discard();
			return true;
		} catch {
			return false;
		}
	}
	return trash(snapshot.backupFile);
}

async function replaceUndoSnapshot(
	state: RewindUndoState,
	next: RewindUndoSnapshot,
	trash: TrashBackup,
	archive: RewindArchive | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const previous = state.current;
	if (archive && next.originalJsonl !== undefined && next.rewoundJsonl !== undefined) {
		traceRewind("rewind.archive_start");
		try {
			const archived = await archive.create({
				originalJsonl: next.originalJsonl,
				rewoundJsonl: next.rewoundJsonl,
				sessionId: next.sessionId,
				sessionFile: next.sessionFile,
				originalDigest: next.originalDigest,
				rewoundDigest: next.rewoundDigest,
				originalLeafId: next.originalLeafId,
				logicalRetainedLeafId: next.logicalRetainedLeafId,
				rewoundLeafId: next.rewoundLeafId,
				originalEditorText: next.originalEditorText,
				rewoundEditorText: next.rewoundEditorText,
				targetEntryId: next.targetEntryId,
				targetRole: next.targetRole,
				targetText: next.targetText,
				discardedDialogueCount: next.discardedDialogueCount,
				discardedPreview: next.discardedPreview,
			});
			next = { ...next, originalJsonl: undefined, rewoundJsonl: undefined, archiveRecord: archived.record };
			if (!archived.retained) {
				ctx.ui.notify("This rewind exceeded the 500 MiB archive budget and was not retained in history.", "warning");
			}
		} catch (error) {
			next = { ...next, originalJsonl: undefined, rewoundJsonl: undefined };
			ctx.ui.notify(`Could not archive this rewind: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			traceRewind("rewind.archive_done");
		}
	}
	state.current = next.rewrite.supportsCheckedReplacement ? next : undefined;
	if (!next.rewrite.supportsCheckedReplacement) {
		const retired = await Promise.all([
			retireUndoSnapshot(next, trash).catch(() => false),
			previous ? retireUndoSnapshot(previous, trash).catch(() => false) : Promise.resolve(true),
		]);
		if (!retired[0]) ctx.ui.notify(`The non-undoable rewind backup remains at ${next.backupFile}`, "warning");
		if (previous && !retired[1]) ctx.ui.notify(`The previous rewind backup remains at ${previous.backupFile}`, "warning");
		return;
	}
	if (!previous || previous.rewrite === next.rewrite) return;
	const trashed = await retireUndoSnapshot(previous, trash).catch(() => false);
	if (!trashed) ctx.ui.notify(`The previous rewind backup remains at ${previous.backupFile}`, "warning");
}

async function restoreArchivedRewind(
	ctx: ExtensionCommandContext,
	archive: RewindArchive,
	record: RewindArchiveRecord,
): Promise<boolean> {
	const manager = ctx.sessionManager;
	const sessionFile = manager.getSessionFile();
	if (manager.getSessionId() !== record.sessionId || sessionFile !== record.sessionFile) {
		ctx.ui.notify("This rewind belongs to another session. Resume that session before restoring it.", "warning");
		return false;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current response to finish before restoring a rewind.", "warning");
		return false;
	}
	const currentBytes = await readSessionSnapshot(sessionFile);
	if (
		sessionBytesDigest(currentBytes) !== record.rewoundDigest
		|| manager.getLeafId() !== record.rewoundLeafId
	) {
		ctx.ui.notify(
			"This rewind is still archived, but the session changed afterward. It was not restored because that would overwrite later work.",
			"warning",
		);
		return false;
	}
	let originalBytes: string;
	try {
		originalBytes = await archive.read(record);
	} catch {
		ctx.ui.notify("This rewind history record is no longer available or failed verification.", "warning");
		return false;
	}
	let restoration: SessionRewrite;
	try {
		restoration = await stageSessionRewrite(sessionFile, originalBytes, {
			expectedCurrentDigest: record.rewoundDigest,
		});
	} catch (error) {
		if (error instanceof CheckedSessionRewriteUnsupportedError) {
			ctx.ui.notify("This filesystem cannot safely restore an archived rewind in place.", "warning");
			return false;
		}
		if (!(error instanceof SessionRewriteConflictError)) throw error;
		ctx.ui.notify("The session changed while archive restore was being committed, so it was not restored.", "warning");
		return false;
	}
	try {
		reloadPrunedSessionFile(manager as unknown as LiveSessionFileControl, sessionFile);
		pointSessionLeaf(manager as unknown as LiveSessionBranchControl, record.rewoundLeafId);
		const navigated = await ctx.navigateTree(record.originalLeafId);
		if (navigated.cancelled) throw new Error("Archive restore was cancelled by a session_before_tree handler");
		restoreEditorSource(ctx.ui, record.originalEditorText);
	} catch (error) {
		try {
			await restoration.rollback({ expectedCurrentDigest: record.originalDigest });
		} catch (rollbackError) {
			if (!(rollbackError instanceof SessionRewriteConflictError)) {
				throw new AggregateError([error, rollbackError], "Archive restore failed and its rollback did not complete");
			}
			reloadPrunedSessionFile(manager as unknown as LiveSessionFileControl, sessionFile);
			ctx.ui.notify("The session changed while archive restore was being decided; the newer session was kept.", "warning");
			return false;
		}
		reloadPrunedSessionFile(manager as unknown as LiveSessionFileControl, sessionFile);
		pointSessionLeaf(manager as unknown as LiveSessionBranchControl, record.rewoundLeafId);
		restoreEditorSource(ctx.ui, record.rewoundEditorText);
		throw error;
	}
	await restoration.discard();
	ctx.ui.notify("Restored the conversation from rewind history.", "info");
	return true;
}

async function undoRewind(
	ctx: ExtensionCommandContext,
	state: RewindUndoState,
	trash: TrashBackup,
	archive: RewindArchive | undefined,
): Promise<void> {
	const snapshot = state.current;
	if (!snapshot) {
		if (archive) {
			try {
				const manager = ctx.sessionManager;
				const sessionFile = manager.getSessionFile();
				if (ctx.isIdle() && sessionFile) {
					const currentBytes = await readSessionSnapshot(sessionFile);
					const currentDigest = sessionBytesDigest(currentBytes);
					const record = (await archive.list()).find((candidate) =>
						candidate.sessionId === manager.getSessionId()
						&& candidate.sessionFile === sessionFile
						&& candidate.rewoundDigest === currentDigest
						&& candidate.rewoundLeafId === manager.getLeafId()
					);
					if (record) {
						await restoreArchivedRewind(ctx, archive, record);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(`Rewind history is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
		}
		ctx.ui.notify("No rewind is available to undo.", "warning");
		return;
	}
	const manager = ctx.sessionManager;
	const sessionFile = manager.getSessionFile();
	if (manager.getSessionId() !== snapshot.sessionId || sessionFile !== snapshot.sessionFile) {
		ctx.ui.notify("The rewind belongs to another session and cannot be undone here.", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current response to finish before undoing a rewind.", "warning");
		return;
	}
	const currentBytes = await readSessionSnapshot(sessionFile);
	if (
		sessionBytesDigest(currentBytes) !== snapshot.rewoundDigest ||
		manager.getLeafId() !== snapshot.rewoundLeafId
	) {
		state.current = undefined;
		const trashed = await retireUndoSnapshot(snapshot, trash).catch(() => false);
		ctx.ui.notify(
			trashed
				? "The session or branch changed after rewind, so that rewind can no longer be undone."
				: `The rewind can no longer be undone automatically; its backup remains at ${snapshot.backupFile}`,
			"warning",
		);
		return;
	}
	const originalBytes = await readSessionSnapshot(snapshot.backupFile);
	if (sessionBytesDigest(originalBytes) !== snapshot.originalDigest) {
		state.current = undefined;
		ctx.ui.notify(`The rewind backup changed and was not restored: ${snapshot.backupFile}`, "warning");
		return;
	}
	let restoration: SessionRewrite;
	try {
		restoration = await stageSessionRewrite(sessionFile, originalBytes, {
			expectedCurrentDigest: snapshot.rewoundDigest,
		});
	} catch (error) {
		if (!(error instanceof SessionRewriteConflictError)) throw error;
		state.current = undefined;
		const trashed = await retireUndoSnapshot(snapshot, trash).catch(() => false);
		ctx.ui.notify(
			trashed
				? "The session changed while undo was being committed, so the rewind was not restored."
				: `The session changed while undo was being committed; its backup remains at ${snapshot.backupFile}`,
			"warning",
		);
		return;
	}
	try {
		reloadPrunedSessionFile(manager as unknown as LiveSessionFileControl, sessionFile);
		pointSessionLeaf(manager as unknown as LiveSessionBranchControl, snapshot.rewoundLeafId);
		const navigated = await ctx.navigateTree(snapshot.originalLeafId);
		if (navigated.cancelled) throw new Error("Undo was cancelled by a session_before_tree handler");
		restoreEditorSource(ctx.ui, snapshot.originalEditorText);
	} catch (error) {
		try {
			await restoration.rollback({ expectedCurrentDigest: snapshot.originalDigest });
		} catch (rollbackError) {
			if (!(rollbackError instanceof SessionRewriteConflictError)) {
				throw new AggregateError([error, rollbackError], "Undo failed and its rollback did not complete");
			}
			// A session_before_tree owner appended while deciding whether to
			// accept the restored branch. Its newer file is now authoritative:
			// reload it, consume the obsolete undo point, and never overwrite it.
			state.current = undefined;
			reloadPrunedSessionFile(manager as unknown as LiveSessionFileControl, sessionFile);
			await Promise.allSettled([
				restoration.discard(),
				snapshot.rewrite.discard(),
			]);
			ctx.ui.notify(
				"The session changed while undo navigation was being decided; the newer session was kept.",
				"warning",
			);
			return;
		}
		reloadPrunedSessionFile(manager as unknown as LiveSessionFileControl, sessionFile);
		pointSessionLeaf(manager as unknown as LiveSessionBranchControl, snapshot.rewoundLeafId);
		restoreEditorSource(ctx.ui, snapshot.rewoundEditorText);
		throw error;
	}
	state.current = undefined;
	const cleanup = await Promise.allSettled([
		restoration.discard(),
		snapshot.rewrite.discard(),
	]);
	const failedCleanup = cleanup.some((result) => result.status === "rejected");
	ctx.ui.notify(
		failedCleanup
			? "Restored the conversation, but one recovery file could not be removed."
			: "Restored the conversation removed by the last rewind.",
		failedCleanup ? "warning" : "info",
	);
}

type RewindHistoryAction = MultiSelectTableAction<string>;

async function pickRewindHistoryAction(
	ctx: ExtensionCommandContext,
	records: readonly RewindArchiveRecord[],
	initialSelectedIds: readonly string[],
): Promise<{ action: RewindHistoryAction; selectedIds: readonly string[] }> {
	let result: { action: RewindHistoryAction; selectedIds: readonly string[] } = {
		action: { kind: "cancel" },
		selectedIds: initialSelectedIds,
	};
	const overlay = createEditorOverlayMount();
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const table = new MultiSelectTable<string, RewindHistoryColumn>({
			tui,
			theme,
			keybindings,
			title: "Rewind history — Enter restores",
			columns: [
				{ id: "time", header: "Time", minWidth: 19, maxWidth: 19 },
				{ id: "target", header: "Target", minWidth: 6, maxWidth: 6 },
				{ id: "discarded", header: "Discarded", minWidth: 9, maxWidth: 9 },
				{ id: "size", header: "Size", minWidth: 7, maxWidth: 9 },
			],
			rows: rewindHistoryRows(records),
			initialRowId: records[0]?.id,
			initialSelectedIds,
			maxVisible: 12,
			emptyText: "No archived rewinds are available for this session.",
			onAction: (action) => {
				result = { action, selectedIds: [...table.selected] };
				done();
			},
		});
		return overlay.mount(tui, table);
	}, overlay.customOptions);
	return result;
}

async function showRewindHistory(
	ctx: ExtensionCommandContext,
	archive: RewindArchive | undefined,
): Promise<void> {
	if (!archive) {
		ctx.ui.notify("Persistent rewind history is disabled.", "warning");
		return;
	}
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("No archived rewinds are available for this session.", "warning");
		return;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	let selectedIds: readonly string[] = [];
	let historyWasShown = false;
	while (true) {
		let records: RewindArchiveRecord[];
		try {
			records = currentSessionHistory(await archive.list(), sessionId, sessionFile);
		} catch (error) {
			ctx.ui.notify(`Rewind history is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		if (records.length === 0) {
			if (!historyWasShown) ctx.ui.notify("No archived rewinds are available for this session.", "warning");
			return;
		}
		const byId = new Map(records.map((record) => [record.id, record]));
		historyWasShown = true;
		const picked = await pickRewindHistoryAction(
			ctx,
			records,
			selectedIds.filter((id) => byId.has(id)),
		);
		selectedIds = picked.selectedIds;
		if (picked.action.kind === "cancel") return;
		if (picked.action.kind === "activate") {
			const record = byId.get(picked.action.id);
			if (record) await restoreArchivedRewind(ctx, archive, record);
			return;
		}
		if (picked.action.kind === "inspect") {
			const record = byId.get(picked.action.id);
			if (record) {
				await showTextPanel(ctx, {
					title: `Rewind · ${new Date(record.createdAt).toLocaleString()}`,
					body: rewindHistoryDetail(record),
					format: "plain",
				});
			}
			continue;
		}
		const targets = picked.action.ids.filter((id) => byId.has(id));
		if (targets.length === 0) continue;
		const confirmed = await ctx.ui.confirm(
			`Delete ${targets.length} rewind archive${targets.length === 1 ? "" : "s"}?`,
			"This removes only the selected recovery archives. The current session is not changed.",
		);
		if (!confirmed) continue;
		try {
			const removal = await archive.removeMany(targets);
			selectedIds = selectedIds.filter((id) => !removal.removedIds.includes(id));
			if (removal.failures.length > 0) {
				ctx.ui.notify(
					`Deleted ${removal.removedIds.length} rewind archive${removal.removedIds.length === 1 ? "" : "s"}; ${removal.failures.length} failed.`,
					"warning",
				);
			} else {
				const missing = removal.missingIds.length > 0 ? `; ${removal.missingIds.length} were already gone` : "";
				ctx.ui.notify(
					`Deleted ${removal.removedIds.length} rewind archive${removal.removedIds.length === 1 ? "" : "s"}${missing}.`,
					"info",
				);
			}
		} catch (error) {
			ctx.ui.notify(`Rewind history deletion failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}
}

/**
 * Finish the editor-slot invocation before the rewind touches the session.
 * Clearing a ui.custom() component does not resolve that component's promise,
 * so rewinding from inside onPick would strand the old /rewind command and its
 * main input loop, and the transcript would repaint under an open panel.
 */
export async function pickRewindChoice(
	ctx: ExtensionCommandContext,
	choices: readonly RewindChoice[],
): Promise<RewindChoice | undefined> {
	choices = choices.filter((choice) => choice.role === "user");
	if (choices.length === 0) return undefined;
	const byId = new Map(choices.map((choice) => [choice.entryId, choice]));
	const initial = choices.at(-1)!.entryId;
	let selected: RewindChoice | undefined;
	await showEditorPanel(ctx, {
		initialScreen: "conversation" as const,
		maxVisible: 12,
		getScreen: () => searchSelectScreen({
			id: "conversation" as const,
			title: "Rewind current path",
			breadcrumbs: [],
			statusLine: `${choices.length} user messages · AI and tools omitted · selection prunes later JSONL entries`,
			initialSelected: initial,
			choices: choices.map((choice) => ({
				value: choice.entryId,
				label: formatRewindChoiceLabel(choice, ctx.ui.theme),
				description: choice.hasImages ? "[image: reattached when its file is available]" : undefined,
				detail: choice.text,
				current: choice.entryId === ctx.sessionManager.getLeafId(),
			})),
			onPick: (entryId, panel) => {
				const choice = byId.get(entryId);
				if (!choice) throw new Error("The selected message is no longer available");
				selected = choice;
				panel.transition({ kind: "close" });
			},
		}),
	});
	return selected;
}

type RewindLabelTheme = Pick<ExtensionCommandContext["ui"]["theme"], "fg">;

/** Role labels differ; every message preview uses the same normal text tone. */
export function formatRewindChoiceLabel(
	choice: Pick<RewindChoice, "role" | "text">,
	theme: RewindLabelTheme,
): string {
	const role = choice.role === "user" ? "You" : "AI ";
	const roleTone = choice.role === "user" ? "accent" : "warning";
	return `${theme.fg(roleTone, role)}  ${theme.fg("text", oneLine(choice.text))}`;
}

function pendingUserChoice(
	branch: readonly SessionEntry[],
	request: PendingConnectionRewindRequest,
): RewindChoice | undefined {
	const baseIndex = request.baseLeafId === null
		? -1
		: branch.findIndex((entry) => entry.id === request.baseLeafId);
	if (request.baseLeafId !== null && baseIndex === -1) return undefined;
	// Match the newest user, never fall back to an older visible picker row.
	let userIndex = branch.length - 1;
	while (userIndex >= 0) {
		const entry = branch[userIndex]!;
		if (entry.type === "message" && entry.message.role === "user") break;
		userIndex--;
	}
	if (userIndex <= baseIndex) return undefined;
	for (let index = baseIndex + 1; index < userIndex; index++) {
		const entry = branch[index]!;
		// Pi can append a tool-loadout system message after input capture;
		// extensions and model/thinking changes can also extend this path.
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			return undefined;
		}
	}
	// Keep the user's actual parent, including any inserted system message.
	return collectRewindChoices([branch[userIndex]!])[0];
}

async function rewindPendingConnection(
	ctx: ExtensionCommandContext,
	state: PendingConnectionRewindState,
	undoState: RewindUndoState,
	trash: TrashBackup,
	archive: RewindArchive | undefined,
	submissions: RewindSubmissionGuard,
): Promise<void> {
	const request = state.takeRequested();
	if (!request) return;
	traceRewind("pending.command_start");
	ctx.abort();
	await ctx.waitForIdle();
	traceRewind("pending.idle");
	const choice = pendingUserChoice(
		ctx.sessionManager.getBranch(),
		request,
	);
	if (!choice) {
		ctx.ui.notify("The pending user message could not be found; the run was cancelled without rewinding.", "warning");
		return;
	}
	const restored = rewindEditorContent(request.editorText, request.hasImages ? 1 : 0);
	const snapshot = await rewindTo(ctx, {
		...choice,
		editorText: restored.editorText,
		hasImages: choice.hasImages || restored.hasImages,
	}, submissions);
	if (snapshot) await replaceUndoSnapshot(undoState, snapshot, trash, archive, ctx);
	traceRewind("pending.command_done");
}

async function showRewind(
	ctx: ExtensionCommandContext,
	undoState: RewindUndoState,
	trash: TrashBackup,
	archive: RewindArchive | undefined,
	submissions: RewindSubmissionGuard,
): Promise<void> {
	const branch = ctx.sessionManager.getBranch();
	const choices = collectRewindChoices(branch);
	if (choices.length === 0) {
		ctx.ui.notify("No user messages are available to rewind.", "warning");
		return;
	}
	const choice = await pickRewindChoice(ctx, choices);
	if (choice) {
		const snapshot = await rewindTo(ctx, choice, submissions);
		if (snapshot) await replaceUndoSnapshot(undoState, snapshot, trash, archive, ctx);
	}
}

export default function piRewind(pi: ExtensionAPI, deps: RewindDependencies = {}): void {
	const pendingConnection = new PendingConnectionRewindState();
	const undoState: RewindUndoState = {};
	const submissions = new RewindSubmissionGuard();
	let rewindInProgress = false;
	const trash = deps.trashBackup ?? trashBackup;
	const archive = deps.archive === false
		? undefined
		: deps.archive ?? new RewindArchive(join(getAgentDir(), "rewind-trash"));
	pi.registerCommand(COMMAND, {
		description: "Rewind the active path, undo the latest rewind, or browse history",
		getArgumentCompletions: rewindArgumentCompletions,
		handler: async (args, ctx) => {
			// Pi can dispatch extension commands concurrently, including while an
			// earlier command awaits idle, picker selection or archive publication.
			// Drop repeats rather than queueing a destructive action for later.
			if (rewindInProgress) return;
			rewindInProgress = true;
			const command = args.trim();
			try {
				if (command === PENDING_CONNECTION_ARG) {
					ctx.ui.setWidget("pi-rewind-progress", ["Rewinding… Enter sends after rewind completes."]);
					return await rewindPendingConnection(ctx, pendingConnection, undoState, trash, archive, submissions);
				}
				if (command === UNDO_ARG) return await undoRewind(ctx, undoState, trash, archive);
				if (command === HISTORY_ARG) return await showRewindHistory(ctx, archive);
				if (command) {
					ctx.ui.notify("Usage: /rewind [undo|history]", "warning");
					return;
				}
				return await showRewind(ctx, undoState, trash, archive, submissions);
			} finally {
				rewindInProgress = false;
				if (command === PENDING_CONNECTION_ARG) ctx.ui.setWidget("pi-rewind-progress", undefined);
			}
		},
	});

	const ensureEditor = (ctx: ExtensionContext): void => {
		try {
			installRewindEditor(ctx, {
				requestPendingConnectionRewind: () => pendingConnection.request(),
				isRewindInProgress: () => rewindInProgress,
				submissionGuard: submissions,
			});
		} catch {
			// A stale replacement-session context can lose its editor while wrapping.
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		pendingConnection.reset();
		const snapshot = undoState.current;
		if (snapshot && (
			snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
			snapshot.sessionFile !== ctx.sessionManager.getSessionFile()
		)) {
			undoState.current = undefined;
			const trashed = await retireUndoSnapshot(snapshot, trash).catch(() => false);
			if (!trashed) ctx.ui.notify(`The previous rewind backup remains at ${snapshot.backupFile}`, "warning");
		}
		ensureEditor(ctx);
	});
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || event.streamingBehavior) return;
		pendingConnection.captureInput(
			event.text,
			ctx.sessionManager.getLeafId(),
			(event.images?.length ?? 0) > 0,
		);
	});
	pi.on("before_agent_start", () => pendingConnection.stageAgent());
	pi.on("agent_start", () => pendingConnection.startAgent());
	// The answer's first real thinking/text/tool content, not the outgoing
	// request and not the empty block a provider opens ahead of its first token:
	// until content arrives, the turn is still only a submitted prompt.
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant" && startHasAnswerContent(event)) {
			pendingConnection.markContentStarted();
		}
	});
	pi.on("message_update", (event) => {
		if (event.message.role === "assistant" && hasAnswerContent(event)) {
			pendingConnection.markContentStarted();
		}
	});
	pi.on("agent_end", () => {
		pendingConnection.finishAgent();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		pendingConnection.reset();
		const snapshot = undoState.current;
		undoState.current = undefined;
		if (!snapshot) return;
		const trashed = await retireUndoSnapshot(snapshot, trash).catch(() => false);
		if (!trashed) ctx.ui.notify(`The rewind backup remains at ${snapshot.backupFile}`, "warning");
	});
}
