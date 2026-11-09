/**
 * pi-todo — minimal replace-on-write todo tool (Claude Code / Codex style).
 *
 * One write semantic: every call sends the complete list and replaces the
 * previous one. Restoration uses the newest successful result/recovery snapshot
 * on the active branch; the memory copy only feeds /todos and compaction
 * re-injection. Design rationale lives in docs/adr/.
 *
 * The tool result's `details` carries the full snapshot with positional ids —
 * that shape is a runtime handshake with pi-claude-style, which renders the
 * collapsible list under the working row from it and drops items without an
 * `id` (its todo-state.ts `toTask`).
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const TOOL_NAME = "todo";
const STATE_MESSAGE_TYPE = "todo-state";

const STRIKE = "\x1b[9m";
const UNSTRIKE = "\x1b[29m";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TodoItemSchema = Type.Object({
	content: Type.String({
		minLength: 1,
		description: "Task description in imperative form, e.g. 'Run tests'",
	}),
	status: Type.Enum(["pending", "in_progress", "completed"], {
		description: "Task status",
	}),
	activeForm: Type.String({
		minLength: 1,
		description: "Present-continuous label shown while in progress, e.g. 'Running tests'",
	}),
});

const TodoParamsSchema = Type.Object({
	explanation: Type.Optional(
		Type.String({
			description:
				"Why the plan changed. Only when restructuring the list (split/merge/reorder/drop), not for routine status updates.",
		}),
	),
	todos: Type.Array(TodoItemSchema, {
		description:
			"The complete todo list. Replaces the previous list entirely — include every task you want to keep. An empty array clears the list.",
	}),
});

type TodoItem = Static<typeof TodoItemSchema>;
type TodoParams = Static<typeof TodoParamsSchema>;
type TodoStatus = TodoItem["status"];

/** Full-snapshot result payload; the `id` exists only for pi-claude-style. */
interface TodoDetails {
	todos: (TodoItem & { id: number })[];
	explanation?: string;
}

// ---------------------------------------------------------------------------
// State — a plain copy of the latest call, for /todos and re-injection only.
// ---------------------------------------------------------------------------

let current: TodoItem[] = [];

function toDetails(explanation?: string): TodoDetails {
	return {
		todos: current.map((todo, index) => ({ id: index + 1, ...todo })),
		...(explanation ? { explanation } : {}),
	};
}

function summary(): string {
	if (current.length === 0) return "Todo list cleared";
	const done = current.filter((todo) => todo.status === "completed").length;
	const active = current.find((todo) => todo.status === "in_progress");
	const head = `${done}/${current.length} completed`;
	return active ? `${head} · in progress: ${active.content}` : head;
}

/**
 * Owned broadcast: the full list, sent on every change (tool execute and
 * session restores). Payload: `{ todos: { id, content, status, activeForm }[] }`
 * — the same shape as the tool result's details. Consumers (pi-claude-style's
 * under-spinner list) subscribe instead of scraping tool results; the list is
 * authoritative from the owner. See docs/pi/events.md.
 */
const TODO_CHANGED_CHANNEL = "todo:changed";
const TODO_SNAPSHOT_CHANNEL = "todo:snapshot-v1";
const TODO_SNAPSHOT_REQUEST_CHANNEL = "todo:request:snapshot-v1";

interface TodoSemanticItemV1 {
	id: number;
	subject: string;
	status: TodoStatus;
	activeForm?: string;
}

interface TodoSnapshotPayloadV1 {
	version: 1;
	sessionId?: string;
	todos: TodoSemanticItemV1[];
}

let currentSessionId: string | undefined;

function semanticSnapshot(): TodoSnapshotPayloadV1 {
	return {
		version: 1,
		...(currentSessionId ? { sessionId: currentSessionId } : {}),
		todos: current.map((todo, index) => ({
			id: index + 1,
			subject: todo.content,
			status: todo.status,
			...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
		})),
	};
}

function publishState(pi: ExtensionAPI): void {
	// Older pi builds (and test stubs) may expose no event bus.
	if (typeof pi.events?.emit !== "function") return;
	pi.events.emit(TODO_SNAPSHOT_CHANNEL, semanticSnapshot());
	pi.events.emit(TODO_CHANGED_CHANNEL, { todos: toDetails().todos });
}

function isTodoItem(value: unknown): value is TodoItem {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Partial<TodoItem>;
	return (
		typeof item.content === "string" && item.content.length > 0 &&
		(item.status === "pending" || item.status === "in_progress" || item.status === "completed")
	);
}

/**
 * Rebuild state from the newest snapshot on the current branch: either a
 * `todo` tool result or a post-compaction `todo-state` message, whichever is
 * later. Embedded compaction recovery retains an exact source entry reference
 * when that carrier has left the projected context.
 */
function restoreFromSession(ctx: ExtensionContext): void {
	current = [];
	let entries: readonly unknown[];
	try {
		entries = ctx.sessionManager.buildContextEntries();
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		const compact = branch.findLast(entry => entry.type === "compaction");
		const recovery = (compact?.details as { recovery?: { version?: number; items?: Array<{ owner: string; customType: string; identity?: { sourceEntryId?: string } }> } } | undefined)?.recovery;
		const sourceId = recovery?.version === 1 && Array.isArray(recovery.items) ? recovery.items.find(item => item.owner === "pi-todo" && item.customType === STATE_MESSAGE_TYPE)?.identity?.sourceEntryId : undefined;
		const source = sourceId ? branch.find(entry => entry.id === sourceId) : undefined;
		if (source) entries = [source, ...entries];
	} catch (error) {
		// Exception messages may quote session contents; keep operation/type context only.
		console.error("pi-todo: failed to restore Todo from active branch; memory mirror cleared",
			error instanceof Error ? error.name : "unknown error");
		return;
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as {
			type?: unknown;
			customType?: unknown;
			details?: unknown;
			message?: unknown;
		};
		const message = entry?.message as
			| { role?: unknown; toolName?: unknown; customType?: unknown; details?: unknown; isError?: unknown }
			| undefined;
		const isToolResult =
			entry?.type === "message" && message?.role === "toolResult" && message.toolName === TOOL_NAME && message.isError !== true;
		const isStateMessage =
			entry?.type === "custom_message" && entry.customType === STATE_MESSAGE_TYPE;
		const isLegacyStateMessage =
			entry?.type === "message" &&
			message?.role === "custom" &&
			message.customType === STATE_MESSAGE_TYPE;
		if (!isToolResult && !isStateMessage && !isLegacyStateMessage) continue;
		const details = (isStateMessage ? entry.details : message?.details) as
			| Partial<TodoDetails>
			| undefined;
		if (!Array.isArray(details?.todos)) continue;
		current = details.todos.filter(isTodoItem).map(({ content, status, activeForm }) => ({
			content,
			status,
			activeForm: typeof activeForm === "string" && activeForm.length > 0 ? activeForm : content,
		}));
		return;
	}
	current = [];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GLYPH: Record<TodoStatus, string> = {
	pending: "□",
	in_progress: "■",
	completed: "✓",
};

function checklistRow(todo: TodoItem, theme: Theme): string {
	if (todo.status === "completed") {
		return theme.fg("muted", `${GLYPH.completed} ${STRIKE}${todo.content}${UNSTRIKE}`);
	}
	if (todo.status === "in_progress") {
		return theme.fg("warning", `${GLYPH.in_progress} `) + theme.bold(todo.content);
	}
	return theme.fg("dim", `${GLYPH.pending} ${todo.content}`);
}

function renderTodoCall(args: TodoParams, theme: Theme): Text {
	// While args stream in, items arrive as partial objects — drop rows that
	// have no content yet instead of printing "undefined".
	const todos = (args.todos ?? []).filter(isTodoItem);
	const done = todos.filter((todo) => todo.status === "completed").length;
	const lines = [
		theme.fg("toolTitle", theme.bold(TOOL_NAME)) + theme.fg("muted", ` ${done}/${todos.length}`),
	];
	if (args.explanation) lines.push(theme.fg("muted", `  ⤷ ${args.explanation}`));
	for (const todo of todos) lines.push(`  ${checklistRow(todo, theme)}`);
	if (todos.length === 0) lines.push(theme.fg("muted", "  (cleared)"));
	return new Text(lines.join("\n"), 0, 0);
}

function renderTodoResult(result: AgentToolResult<TodoDetails>, theme: Theme): Text {
	const text = result.content
		.map((block) => ("text" in block ? block.text : ""))
		.join("")
		.trim();
	return new Text(theme.fg("muted", text || "ok"), 0, 0);
}

// ---------------------------------------------------------------------------
// Re-injection after compaction — the one moment the transcript loses state.
// ---------------------------------------------------------------------------

function stateForLLM(): string {
	const rows = current.map((todo) => {
		const box =
			todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]";
		return `${box} ${todo.content}`;
	});
	return [
		"<todo-state>",
		"Current todo list, restored after context compaction. Keep maintaining it with the `todo` tool (every call replaces the whole list).",
		...rows,
		"</todo-state>",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Prompt guidance — behavioral rules live here, not in the schema.
// ---------------------------------------------------------------------------

const PROMPT_SNIPPET = "Track multi-step work with a replace-on-write todo list";
const PROMPT_GUIDELINES = [
	"Use `todo` for non-trivial work with 3+ steps or when the user lists several tasks; skip it for single trivial tasks and conversational replies.",
	"Every `todo` call sends the COMPLETE list and replaces the previous one — to change one task's status, resend the whole list with that entry updated. An empty list clears it.",
	"Exactly one task in_progress at a time. Mark it in_progress before starting work and completed immediately when done — never batch completions, never jump pending → completed.",
	"Never mark a task completed while tests fail or the work is partial — keep it in_progress and add a task for the blocker.",
	"content is imperative ('Run tests'); activeForm is present-continuous ('Running tests'). Set explanation only when restructuring the plan.",
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let currentContext: ExtensionContext | undefined;
	const releaseRecovery = pi.events.on("pi-session-compact:collect-recovery-v1", (raw: unknown) => {
		const request = raw as { version?: number; sessionId?: string; operationId?: string; reply?: (item: unknown) => void };
		if (request?.version !== 1 || typeof request.operationId !== "string" || typeof request.reply !== "function" || request.sessionId !== currentSessionId || !currentContext || !current.some(todo => todo.status !== "completed")) return;
		const source = currentContext.sessionManager.getBranch?.().findLast(entry => entry.type === "custom_message" && entry.customType === STATE_MESSAGE_TYPE || entry.type === "message" && (entry.message.role === "toolResult" && entry.message.toolName === TOOL_NAME && entry.message.isError !== true || entry.message.role === "custom" && entry.message.customType === STATE_MESSAGE_TYPE));
		request.reply({ owner: "pi-todo", order: 20, customType: STATE_MESSAGE_TYPE, identity: { sourceEntryId: source?.id }, content: stateForLLM() });
	});
	pi.events.on(TODO_SNAPSHOT_REQUEST_CHANNEL, (value) => {
		if (!value || typeof value !== "object") return;
		const request = value as { sessionId?: unknown; reply?: unknown };
		if (typeof request.reply !== "function") return;
		if (request.sessionId !== undefined && typeof request.sessionId !== "string") return;
		const snapshot = semanticSnapshot();
		if (request.sessionId && request.sessionId !== snapshot.sessionId) return;
		try {
			(request.reply as (payload: TodoSnapshotPayloadV1) => void)(snapshot);
		} catch {
			// A consumer callback cannot interrupt the todo owner's state update.
		}
	});
	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo",
		description:
			"Update the todo list for the current task. Each call replaces the entire list — pass the complete updated list every time (add, reorder, change status, and drop tasks in one call). Use it to plan multi-step work and show progress.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params: TodoParams) {
			current = params.todos.map(({ content, status, activeForm }) => ({ content, status, activeForm }));
			publishState(pi);
			return {
				content: [{ type: "text" as const, text: summary() }],
				details: toDetails(params.explanation),
			};
		},

		renderCall(args, theme) {
			return renderTodoCall(args, theme);
		},

		renderResult(result, _options, theme) {
			return renderTodoResult(result, theme);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (current.length === 0) {
				ctx.ui.notify("No todos.", "info");
				return;
			}
			const done = current.filter((todo) => todo.status === "completed").length;
			const lines = [`${done}/${current.length} completed`];
			for (const todo of current) {
				const form =
					todo.status === "in_progress" && todo.activeForm ? ` — ${todo.activeForm}` : "";
				lines.push(`${GLYPH[todo.status]} ${todo.content}${form}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		currentSessionId = readSessionId(ctx);
		restoreFromSession(ctx);
		publishState(pi);
	});

	pi.on("session_tree", (_event, ctx) => {
		currentContext = ctx;
		currentSessionId = readSessionId(ctx);
		restoreFromSession(ctx);
		publishState(pi);
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (event.reason === "quit" || event.reason === "reload") releaseRecovery();
		current = [];
		currentSessionId = undefined;
		publishState(pi);
	});

	pi.on("session_compact", (event) => {
		const recovery = (event?.compactionEntry?.details as { recovery?: { version?: number; items?: Array<{ owner: string; customType: string }> } } | undefined)?.recovery;
		if (recovery?.version === 1 && Array.isArray(recovery.items) && recovery.items.some(item => item.owner === "pi-todo" && item.customType === STATE_MESSAGE_TYPE)) return;
		if (current.length === 0) return;
		if (!current.some((todo) => todo.status !== "completed")) return;
		pi.sendMessage(
			{
				customType: STATE_MESSAGE_TYPE,
				content: stateForLLM(),
				display: false,
				details: toDetails(),
			},
			{ triggerTurn: false },
		);
	});
}

function readSessionId(ctx: ExtensionContext): string | undefined {
	const sessionManager = ctx.sessionManager as { getSessionId?: () => unknown };
	const sessionId = sessionManager.getSessionId?.();
	return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}
