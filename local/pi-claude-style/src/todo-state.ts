import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { onLeftClick } from "./clickable.ts";
import { claudeIndicatorPalette, RESET_FG } from "./cyber-style.ts";
import { PINNED_WORKING_CHILD_INDENT } from "./working-layout.ts";
import { readTasks, readTasksFromSession } from "./todo-state-legacy.ts";

/** A task, in the one shape this file works with. */
export interface HostedTask {
	readonly id: number | string;
	readonly subject: string;
	readonly status: string;
	readonly activeForm?: string;
	readonly blockedBy?: (number | string)[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";
const RESET = "\x1b[0m";

/** Connector tying the list to the working row above it. */
const CONNECTOR = "└";
const ACTIVE_GLYPH = "■";
const PENDING_GLYPH = "□";
const DONE_GLYPH = "✓";
const STRIKE = "\x1b[9m";
const UNSTRIKE = "\x1b[29m";

export { readTasks, readTasksFromSession } from "./todo-state-legacy.ts";

/** Parse pi-todo's versioned semantic snapshot without importing its package. */
export function readTodoSnapshotV1(
	value: unknown,
	sessionId?: string,
): HostedTask[] | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (sessionId && value.sessionId !== sessionId) return undefined;
	if (!Array.isArray(value.todos)) return undefined;
	const parsed = value.todos.map((item): HostedTask | undefined => {
		if (!isRecord(item)) return undefined;
		if (typeof item.id !== "number" && typeof item.id !== "string") return undefined;
		if (typeof item.subject !== "string") return undefined;
		if (
			item.status !== "pending" &&
			item.status !== "in_progress" &&
			item.status !== "completed"
		) return undefined;
		if (item.activeForm !== undefined && typeof item.activeForm !== "string") return undefined;
		return {
			id: item.id,
			subject: item.subject,
			status: item.status,
			...(item.activeForm === undefined ? {} : { activeForm: item.activeForm }),
		};
	}).filter((task): task is HostedTask => !!task);
	return parsed.length === value.todos.length ? parsed : undefined;
}

/**
 * Read the list back from the session when there is nothing to draw.
 *
 * `/reload` rebuilds this extension but never replays `session_start`, so a
 * fresh instance starts with an empty snapshot while the session it is running
 * in is full of tasks. Reading is guarded by the snapshot being empty, so the
 * events this hangs off cost nothing once the list is in hand.
 */
export function seedIfEmpty(
	snapshot: TodoSnapshot,
	readEntries: () => readonly unknown[],
	isTodoTool: (toolName: string) => boolean,
): boolean {
	if (snapshot.visible().length > 0) return false;
	try {
		const tasks = readTasksFromSession(readEntries(), isTodoTool);
		snapshot.seed(tasks);
		return tasks !== undefined;
	} catch {
		// A session that cannot be read is not worth failing an event over.
		return false;
	}
}

/** Holds the latest snapshot the todo tool reported this session. */
export class TodoSnapshot {
	private tasks: HostedTask[] = [];
	/**
	 * Whether the persistent block is drawn as one summary row.
	 *
	 * View state stays on the snapshot because the same list is rendered under
	 * the working row and between runs. Mouse clicks and the explicit shortcut
	 * both toggle this same state.
	 */
	private collapsed = false;
	/** All-done lists stay statusline-only until the explicit shortcut expands them. */
	private completedExpanded = false;

	update(details: unknown): boolean {
		const tasks = readTasks(details);
		if (!tasks) return false;
		this.replaceTasks(tasks);
		return true;
	}

	/** Replace state with an already validated semantic owner snapshot. */
	replace(tasks: readonly HostedTask[]): void {
		this.replaceTasks(tasks);
	}

	/** Adopt a list read back from the session, if there was one. */
	seed(tasks: HostedTask[] | undefined): void {
		if (tasks) this.replaceTasks(tasks);
	}

	clear(): void {
		this.tasks = [];
		this.completedExpanded = false;
	}

	isCollapsed(): boolean {
		return this.isAllCompleted() ? !this.completedExpanded : this.collapsed;
	}

	/** Finished lists are absent above the editor unless explicitly expanded. */
	isStatuslineOnly(): boolean {
		return this.isAllCompleted() && !this.completedExpanded;
	}

	isAllCompleted(): boolean {
		const visible = this.visible();
		return visible.length > 0 && visible.every((task) => task.status === "completed");
	}

	/** Set the starting state from config, without disturbing a session choice. */
	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
	}

	/** Returns the state it landed on, so the caller can say which way it went. */
	toggleCollapsed(): boolean {
		if (this.isAllCompleted()) {
			this.completedExpanded = !this.completedExpanded;
			return !this.completedExpanded;
		}
		this.collapsed = !this.collapsed;
		return this.collapsed;
	}

	/** Open work only: what is left to do. */
	open(): HostedTask[] {
		return this.tasks.filter(
			(task) => task.status === "pending" || task.status === "in_progress",
		);
	}

	/**
	 * Everything worth drawing, in the order the tool reported it — finished
	 * work included, because a list that only ever shows what is left says
	 * nothing about how far along it is. Deleted and cancelled rows drop out:
	 * they were withdrawn, not done.
	 */
	visible(): HostedTask[] {
		return this.tasks.filter(
			(task) => task.status !== "deleted" && task.status !== "cancelled",
		);
	}

	private replaceTasks(tasks: readonly HostedTask[]): void {
		const wasAllCompleted = this.isAllCompleted();
		this.tasks = [...tasks];
		const isAllCompleted = this.isAllCompleted();
		// Entering the completed state always starts in the statusline. Repeated
		// owner snapshots retain an explicit expansion made by the reader.
		if (!isAllCompleted || !wasAllCompleted) this.completedExpanded = false;
	}
}

/** One fold action shared by the Todo widget, statusline slot, and shortcut. */
export function toggleTodoView(todos: TodoSnapshot, redraw: () => void): boolean {
	if (todos.visible().length === 0) return false;
	todos.toggleCollapsed();
	redraw();
	return true;
}

/** The todo segment contributed to the third statusline row. */
export function renderTodoStatusLine(tasks: readonly HostedTask[]): string | undefined {
	const visible = tasks.filter(
		(task) => task.status !== "deleted" && task.status !== "cancelled",
	);
	if (visible.length === 0) return undefined;
	const done = visible.filter((task) => task.status === "completed").length;
	const allCompleted = done === visible.length;
	const inProgress = visible.some((task) => task.status === "in_progress");
	const color = allCompleted ? "90" : inProgress ? "33" : "36";
	const label = allCompleted
		? `${DONE_GLYPH} todo ${done}/${visible.length}`
		: `todo ${done}/${visible.length}`;
	return `${BOLD}\x1b[${color}m${label}${RESET}`;
}

export interface TodoBlockOptions {
	indent?: string;
	/**
	 * Tie the first row to the row above with `└`. That is what makes the list
	 * read as hanging off the working row; standing on its own between runs it
	 * would dangle from nothing, so the same rows are drawn without it.
	 */
	connector?: boolean;
	/**
	 * Rows the block may occupy. A long list is mostly finished work, so that
	 * is what gives way first: the oldest completed rows collapse into a single
	 * `✓ N done`, and everything still open stays.
	 */
	maxRows?: number;
	/**
	 * Draw the whole list as one row instead of one row per task.
	 *
	 * Distinct from `maxRows`, which folds *finished* work when the list runs
	 * long and never touches what is still open. This folds everything, on
	 * purpose: it is the reader saying they know what they asked for and want
	 * the screen back.
	 */
	collapsed?: boolean;
}

/** Default row budget: enough for a working list, short of taking the screen. */
const DEFAULT_MAX_ROWS = 10;

/**
 * The task list: a row per open task, in-progress rows carrying weight and the
 * extension's terracotta, pending rows dim so the eye lands on what is running.
 *
 * The same rows under the working row and on their own, so the list does not
 * change shape when the spinner stops.
 */
export function renderTodoBlock(
	tasks: HostedTask[],
	options: TodoBlockOptions = {},
): string[] {
	if (tasks.length === 0) return [];
	const indent = options.indent ?? "  ";
	const connector = options.connector ?? true;
	const maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);

	const drawn = options.collapsed
		? [summaryRow(tasks)]
		: expandedRows(tasks, maxRows);

	return drawn.map((text, index) => {
		const lead = connector
			? index === 0 ? `${DIM}${CONNECTOR}${UNDIM} ` : "  "
			: "";
		return `${indent}${lead}${text}`;
	});
}

function expandedRows(tasks: HostedTask[], maxRows: number): string[] {
	const { rows, collapsed } = fitToBudget(tasks, maxRows);
	const drawn = rows.map((task) => body(task));
	if (collapsed > 0) drawn.unshift(`${DIM}${DONE_GLYPH} ${collapsed} done${UNDIM}`);
	return drawn;
}

/**
 * The folded form: progress, and the one task that answers "what now".
 *
 * That is the task in progress; with none running it is the next thing
 * pending, because a bare count says how much is left but not what is next.
 * The subject keeps the weight and colour it has when expanded, so folding
 * changes how much is on screen without changing what the eye looks for.
 */
function summaryRow(tasks: HostedTask[]): string {
	const done = tasks.filter((task) => task.status === "completed").length;
	const count = `${DIM}${done}/${tasks.length}${UNDIM}`;
	const active = tasks.find((task) => task.status === "in_progress");
	if (active) {
		return `${claudeIndicatorPalette.base}${ACTIVE_GLYPH}${RESET_FG} ${count} ${DIM}·${UNDIM} ${BOLD}${active.subject}${UNBOLD}`;
	}
	const next = tasks.find((task) => task.status === "pending");
	if (next) {
		return `${DIM}${PENDING_GLYPH} ${done}/${tasks.length} · ${next.subject}${UNDIM}`;
	}
	// Nothing open: the list is finished, and the count is the whole story.
	if (done === tasks.length) {
		return `${DIM}${DONE_GLYPH} todo ${done}/${tasks.length}${UNDIM}`;
	}
	return `${DIM}${DONE_GLYPH} ${done}/${tasks.length}${UNDIM}`;
}

/** One row: glyph, weight and tone by what the task is doing. */
function body(task: HostedTask): string {
	if (task.status === "in_progress") {
		return `${claudeIndicatorPalette.base}${ACTIVE_GLYPH}${RESET_FG} ${BOLD}${task.subject}${UNBOLD}`;
	}
	if (task.status === "completed") {
		// Struck through as well as dimmed: a terminal that ignores one still
		// shows the other, and both read as "not this any more".
		return `${DIM}${DONE_GLYPH} ${STRIKE}${task.subject}${UNSTRIKE}${UNDIM}`;
	}
	return `${DIM}${PENDING_GLYPH} ${task.subject}${UNDIM}`;
}

/**
 * Fit the list to its row budget by collapsing finished work, oldest first.
 * Open tasks are never dropped — a budget that hid what is left to do would
 * defeat the row entirely — so a list of nothing but open work overruns rather
 * than lying about itself.
 */
function fitToBudget(
	tasks: HostedTask[],
	maxRows: number,
): { rows: HostedTask[]; collapsed: number } {
	if (tasks.length <= maxRows) return { rows: tasks, collapsed: 0 };

	const completed = tasks.filter((task) => task.status === "completed");
	const open = tasks.filter((task) => task.status !== "completed");
	// The summary itself costs a row.
	const keepCompleted = Math.max(0, maxRows - 1 - open.length);
	if (keepCompleted >= completed.length) return { rows: tasks, collapsed: 0 };

	const kept = new Set(completed.slice(completed.length - keepCompleted));
	return {
		rows: tasks.filter((task) => task.status !== "completed" || kept.has(task)),
		collapsed: completed.length - keepCompleted,
	};
}

/**
 * The todo row below the working status, as a component so it can be clicked.
 *
 * Mounted through the `setWidget` factory overload rather than as a string
 * array, so Pi's mouse dispatch has a component to deliver the click to.
 * Clicking toggles the same fold state as `Alt+T`.
 *
 * It remains mounted while the agent is running. Putting the list inside
 * `setWorkingMessage` would turn it into opaque text and make mouse navigation
 * impossible; instead, `connectToWorking` changes only its visual connector.
 */
export class TodoWidget implements Component {
	private readonly todos: TodoSnapshot;
	private readonly toggle: () => boolean;
	private readonly connectToWorking: () => boolean;

	constructor(
		todos: TodoSnapshot,
		toggle: () => boolean,
		connectToWorking: () => boolean = () => false,
	) {
		this.todos = todos;
		this.toggle = toggle;
		this.connectToWorking = connectToWorking;
	}

	render(width: number): string[] {
		if (this.todos.isStatuslineOnly()) return [];
		return renderTodoBlock(this.todos.visible(), {
			// A custom component receives no automatic horizontal margin. Use
			// three source columns so its connector lands at screen column 3,
			// matching a Loader child row after Loader's one-column margin.
			indent: PINNED_WORKING_CHILD_INDENT,
			connector: this.connectToWorking(),
			collapsed: this.todos.isCollapsed(),
			// Mounted as-is means nothing downstream truncates for us: a subject
			// wider than the terminal is a hard doRender crash, not a wrap.
		}).map((row) =>
			truncateToWidth(row, width, `${DIM}…${UNDIM}`)
		);
	}

	invalidate(): void {
		// Rendered from the snapshot every frame; there is nothing cached to drop.
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return onLeftClick(event, () => this.todos.visible().length > 0 && this.toggle());
	}
}
