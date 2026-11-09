import assert from "node:assert/strict";
import test from "node:test";
import { click } from "./native-mouse.ts";
import { Loader } from "@earendil-works/pi-tui";
import {
	readTasks,
	readTasksFromSession,
	readTodoSnapshotV1,
	renderTodoBlock,
	renderTodoStatusLine,
	seedIfEmpty,
	TodoSnapshot,
	TodoWidget,
	toggleTodoView,
} from "../src/todo-state.ts";
import {
	PINNED_WORKING_CHILD_INDENT,
	WORKING_CHILD_COLUMN,
	WORKING_INDICATOR_COLUMN,
	workingMessageWidth,
} from "../src/working-layout.ts";
import { WorkingToolsWidget } from "../src/working-tools.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const TASKS = [
	{ id: 1, subject: "建立 fork 合并基线", status: "completed" as const },
	{ id: 2, subject: "补齐 fork 元数据", status: "in_progress" as const, activeForm: "补齐中" },
	{ id: 3, subject: "实现 pi-fork-update 扩展", status: "pending" as const },
];

test("takes the task list only from a well-formed result", () => {
	assert.deepEqual(readTasks({ tasks: TASKS }), TASKS);
	assert.equal(readTasks(undefined), undefined);
	assert.equal(readTasks({}), undefined);
	assert.equal(readTasks({ tasks: "nope" }), undefined);
	// A half-parsed list would silently drop rows, so reject the whole payload.
	assert.equal(readTasks({ tasks: [TASKS[0], { id: 9 }] }), undefined);
});

test("accepts only the current todo semantic snapshot for this session", () => {
	assert.deepEqual(
		readTodoSnapshotV1({ version: 1, sessionId: "s1", todos: TASKS }, "s1"),
		TASKS,
	);
	assert.deepEqual(readTodoSnapshotV1({ version: 1, sessionId: "s1", todos: [] }, "s1"), []);
	assert.equal(
		readTodoSnapshotV1({ version: 2, sessionId: "s1", todos: TASKS }, "s1"),
		undefined,
	);
	assert.equal(
		readTodoSnapshotV1({ version: 1, sessionId: "other", todos: TASKS }, "s1"),
		undefined,
	);
	assert.equal(
		readTodoSnapshotV1({ version: 1, todos: TASKS }, "s1"),
		undefined,
		"a scoped consumer must not adopt an owner that has not bound its session",
	);
	assert.equal(
		readTodoSnapshotV1({ version: 1, sessionId: "s1", todos: [TASKS[0], { id: 2 }] }, "s1"),
		undefined,
		"partial semantic snapshots fail closed",
	);
});

test("keeps only open work, newest snapshot wins", () => {
	const snapshot = new TodoSnapshot();
	assert.deepEqual(snapshot.open(), []);

	assert.equal(snapshot.update({ tasks: TASKS }), true);
	assert.deepEqual(
		snapshot.open().map((task) => task.id),
		[2, 3],
	);

	// A malformed result must not wipe the list it could not parse.
	assert.equal(snapshot.update({ tasks: "nope" }), false);
	assert.equal(snapshot.open().length, 2);

	snapshot.update({ tasks: [{ id: 3, subject: "实现 pi-fork-update 扩展", status: "completed" }] });
	assert.deepEqual(snapshot.open(), []);
});

test("hangs the list off the working row, active one first-class", () => {
	const lines = renderTodoBlock([TASKS[1]!, TASKS[2]!]);
	assert.equal(lines.length, 2);
	assert.equal(strip(lines[0]!), "  └ ■ 补齐 fork 元数据");
	assert.equal(strip(lines[1]!), "    □ 实现 pi-fork-update 扩展");
	// Weight and colour carry the active row; pending rows stay dim.
	assert.match(lines[0]!, /\x1b\[1m/);
	assert.doesNotMatch(lines[1]!, /\x1b\[1m/);
	assert.match(lines[1]!, /\x1b\[2m/);
	assert.deepEqual(renderTodoBlock([]), []);
});

test("the same rows stand on their own between runs, minus the connector", () => {
	// The list must not change shape when the spinner stops, so only the tie to
	// the row above goes away.
	const hanging = renderTodoBlock([TASKS[1]!, TASKS[2]!]);
	const standalone = renderTodoBlock([TASKS[1]!, TASKS[2]!], {
		indent: "",
		connector: false,
	});

	assert.deepEqual(standalone.map(strip), ["■ 补齐 fork 元数据", "□ 实现 pi-fork-update 扩展"]);
	// Same glyphs, same weight, same tones as the rows under the working line.
	assert.equal(strip(hanging[0]!).replace("  └ ", ""), strip(standalone[0]!));
	assert.match(standalone[0]!, /\x1b\[1m/);
	assert.match(standalone[1]!, /\x1b\[2m/);
});

test("reads a todowrite-shaped result as well as an rpiv-todo one", () => {
  // The two providers disagree on both names; reading only one of them is how
  // the row under the working line ends up empty next to a full todo panel.
  const rpiv = readTasks({
    tasks: [{ id: 1, subject: "分析 bug 根因并修复", status: "in_progress" }],
  });
  assert.equal(rpiv?.[0]?.subject, "分析 bug 根因并修复");

  const todowrite = readTasks({
    todos: [{ id: "1", content: "示例任务", status: "pending", priority: "high" }],
  });
  assert.equal(todowrite?.[0]?.subject, "示例任务");
  assert.equal(todowrite?.[0]?.status, "pending");
});

test("a list this file only half understands is not a snapshot", () => {
  assert.equal(readTasks({ tasks: [{ id: 1, subject: "ok", status: "pending" }, { nope: 1 }] }), undefined);
  assert.equal(readTasks({}), undefined);
  assert.equal(readTasks(undefined), undefined);
});

test("the newest todo result in a session is the one that seeds the row", () => {
  const isTodo = (name: string) => name === "todo" || name === "todowrite";
  const result = (toolName: string, details: unknown) => ({
    type: "message",
    message: { role: "toolResult", toolName, details },
  });
  const entries = [
    result("todo", { tasks: [{ id: 1, subject: "old", status: "pending" }] }),
    result("read", { path: "x" }),
    result("todowrite", { todos: [{ id: 2, content: "new", status: "in_progress" }] }),
    { type: "message", message: { role: "assistant", content: [] } },
  ];

  assert.equal(readTasksFromSession(entries, isTodo)?.[0]?.subject, "new");
  assert.equal(readTasksFromSession([], isTodo), undefined);
  assert.equal(
    readTasksFromSession([result("read", { path: "x" })], isTodo),
    undefined,
    "a session that never touched a todo tool seeds nothing",
  );
});

test("seeding adopts a list, and a missing one leaves what is there", () => {
  const snapshot = new TodoSnapshot();
  snapshot.seed([{ id: 1, subject: "from history", status: "pending" }]);
  assert.equal(snapshot.open().length, 1);
  snapshot.seed(undefined);
  assert.equal(snapshot.open()[0]?.subject, "from history");
});

test("finished work is drawn too, struck through and dimmed", () => {
	// A list that only ever showed what is left said nothing about how far
	// along it was.
	const lines = renderTodoBlock(TASKS);
	assert.deepEqual(lines.map(strip), [
		"  └ ✓ 建立 fork 合并基线",
		"    ■ 补齐 fork 元数据",
		"    □ 实现 pi-fork-update 扩展",
	]);
	assert.match(lines[0]!, /\x1b\[9m/, "struck through");
	assert.match(lines[0]!, /\x1b\[2m/, "and dimmed, for terminals that ignore one");
});

test("visible() keeps finished work and drops what was withdrawn", () => {
	const snapshot = new TodoSnapshot();
	snapshot.seed([
		{ id: 1, subject: "done", status: "completed" },
		{ id: 2, subject: "doing", status: "in_progress" },
		{ id: 3, subject: "dropped", status: "deleted" },
		{ id: 4, subject: "cancelled", status: "cancelled" },
	]);
	assert.deepEqual(snapshot.visible().map((task) => task.subject), ["done", "doing"]);
	assert.deepEqual(snapshot.open().map((task) => task.subject), ["doing"]);
});

test("a long list collapses finished work, oldest first, and keeps what is open", () => {
	const tasks = Array.from({ length: 16 }, (_, index) => ({
		id: index + 1,
		subject: `任务 ${index + 1}`,
		status: index < 14 ? "completed" : index === 14 ? "in_progress" : "pending",
	}));

	const lines = renderTodoBlock(tasks, { maxRows: 10 }).map(strip);
	assert.equal(lines.length, 10, "the budget is kept");
	assert.equal(lines[0], "  └ ✓ 7 done", "the oldest finished rows become a count");
	assert.equal(lines.at(-2), "    ■ 任务 15", "everything open survives");
	assert.equal(lines.at(-1), "    □ 任务 16");
});

test("a budget never hides open work", () => {
	const open = Array.from({ length: 12 }, (_, index) => ({
		id: index + 1,
		subject: `任务 ${index + 1}`,
		status: "pending",
	}));
	// Nothing finished to give way, so the block overruns rather than lying.
	assert.equal(renderTodoBlock(open, { maxRows: 4 }).length, 12);
});

test("an empty snapshot reads the session back; a full one is left alone", () => {
	// `/reload` rebuilds this extension without replaying session_start, so a
	// fresh instance would otherwise sit empty next to a session full of tasks.
	const isTodo = (name: string) => name === "todo";
	const entries = [{
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: { tasks: [{ id: 1, subject: "from the session", status: "pending" }] },
		},
	}];

	const snapshot = new TodoSnapshot();
	let reads = 0;
	const readEntries = () => {
		reads++;
		return entries;
	};

	assert.equal(seedIfEmpty(snapshot, readEntries, isTodo), true);
	assert.equal(snapshot.visible()[0]?.subject, "from the session");
	assert.equal(reads, 1);

	// Already holding a list: the session is not re-read, however many events
	// this hangs off.
	assert.equal(seedIfEmpty(snapshot, readEntries, isTodo), false);
	assert.equal(reads, 1);
});

test("a session with no todo history seeds nothing and stays empty", () => {
	const snapshot = new TodoSnapshot();
	assert.equal(seedIfEmpty(snapshot, () => [], () => true), false);
	assert.deepEqual(snapshot.visible(), []);
});

test("a session that cannot be read does not take the event with it", () => {
	const snapshot = new TodoSnapshot();
	assert.equal(
		seedIfEmpty(snapshot, () => {
			throw new Error("no branch");
		}, () => true),
		false,
	);
});

// ------------------------------------------------------------------ folding

test("folded, the whole list is one row naming what is running", () => {
	const rows = renderTodoBlock(TASKS, { collapsed: true });
	assert.equal(rows.length, 1);
	assert.equal(strip(rows[0]!), "  └ ■ 1/3 · 补齐 fork 元数据");
});

test("folded with nothing running, it names what is next", () => {
	const idle = TASKS.map((task) =>
		task.status === "in_progress" ? { ...task, status: "pending" as const } : task,
	);
	assert.equal(strip(renderTodoBlock(idle, { collapsed: true })[0]!), "  └ □ 1/3 · 补齐 fork 元数据");
});

test("an explicitly expanded completed list keeps every finished row", () => {
	const done = TASKS.map((task) => ({ ...task, status: "completed" as const }));
	assert.equal(renderTodoBlock(done).length, 3);
	assert.deepEqual(
		renderTodoBlock(done, { collapsed: true }).map(strip),
		["  └ ✓ todo 3/3"],
	);
});

test("the statusline keeps the completed check and progress palette", () => {
	const done = TASKS.map((task) => ({ ...task, status: "completed" as const }));
	assert.equal(strip(renderTodoStatusLine(done)!), "✓ todo 3/3");
	assert.match(renderTodoStatusLine(done)!, /\x1b\[90m/);
	assert.equal(strip(renderTodoStatusLine(TASKS)!), "todo 1/3");
	assert.match(renderTodoStatusLine(TASKS)!, /\x1b\[33m/);
	assert.equal(renderTodoStatusLine([]), undefined);
});

test("folding keeps the in-progress task's weight and colour", () => {
	// Folding changes how much is on screen, not what the eye is drawn to.
	const folded = renderTodoBlock(TASKS, { collapsed: true })[0]!;
	const expanded = renderTodoBlock(TASKS)[1]!;
	const activeColour = /\x1b\[38;5;\d+m/;
	assert.match(folded, activeColour);
	assert.match(expanded, activeColour);
	assert.ok(folded.includes("\x1b[1m"), "折叠行应当保留加粗");
});

test("folding respects indent and connector like the expanded block", () => {
	const rows = renderTodoBlock(TASKS, { collapsed: true, indent: "", connector: false });
	assert.equal(rows.length, 1);
	assert.equal(strip(rows[0]!), "■ 1/3 · 补齐 fork 元数据");
});

test("an empty list draws nothing, folded or not", () => {
	assert.deepEqual(renderTodoBlock([], { collapsed: true }), []);
	assert.deepEqual(renderTodoBlock([]), []);
});

test("folding is a property of the snapshot, so both render sites agree", () => {
	// The list is drawn under the working row and as a widget between runs. The
	// flag lives on the object both of them hold, which is what stops the two
	// halves disagreeing about whether it is folded.
	const snapshot = new TodoSnapshot();
	snapshot.update({ tasks: TASKS });
	assert.equal(snapshot.isCollapsed(), false);
	assert.equal(snapshot.toggleCollapsed(), true);
	assert.equal(snapshot.isCollapsed(), true);
	assert.equal(snapshot.toggleCollapsed(), false);

	snapshot.setCollapsed(true);
	assert.equal(snapshot.isCollapsed(), true);
});

test("a new task list does not unfold the view", () => {
	// The fold is the reader's choice; the tool reporting progress is not a
	// reason to take the screen back.
	const snapshot = new TodoSnapshot();
	snapshot.setCollapsed(true);
	snapshot.update({ tasks: TASKS });
	assert.equal(snapshot.isCollapsed(), true);
});

test("the shared Todo action toggles active and completed views but ignores empties", () => {
	const empty = new TodoSnapshot();
	let redraws = 0;
	assert.equal(toggleTodoView(empty, () => redraws++), false);
	assert.equal(redraws, 0);

	const active = new TodoSnapshot();
	active.update({ tasks: TASKS });
	assert.equal(toggleTodoView(active, () => redraws++), true);
	assert.equal(active.isCollapsed(), true);
	assert.equal(redraws, 1);

	const completed = new TodoSnapshot();
	completed.update({ tasks: TASKS.map((task) => ({ ...task, status: "completed" })) });
	assert.equal(completed.isStatuslineOnly(), true);
	assert.equal(toggleTodoView(completed, () => redraws++), true);
	assert.equal(completed.isStatuslineOnly(), false);
	assert.equal(redraws, 2);
});

test("folding wins over the row budget rather than fighting it", () => {
	// `maxRows` folds finished work when the list runs long; this folds
	// everything. Asked for both, the explicit one decides.
	const many = Array.from({ length: 30 }, (_, i) => ({
		id: i, subject: `任务 ${i}`, status: i === 0 ? "in_progress" as const : "pending" as const,
	}));
	assert.equal(renderTodoBlock(many, { collapsed: true, maxRows: 3 }).length, 1);
	assert.ok(renderTodoBlock(many, { maxRows: 3 }).length > 1);
});

test("the todo widget toggles its persistent fold state", () => {
	const snapshot = new TodoSnapshot();
	snapshot.update({ tasks: TASKS });
	let toggles = 0;
	const widget = new TodoWidget(snapshot, () => {
		toggles++;
		snapshot.toggleCollapsed();
		return true;
	});

	assert.equal(widget.render(80).length, 3, "起始是展开的");
	assert.equal(click(widget, 0, 0), true);
	assert.equal(toggles, 1);
	assert.equal(snapshot.isCollapsed(), true);
	assert.equal(widget.render(80).length, 1, "点击后折叠成摘要行");
	assert.equal(click(widget, 0, 0), true);
	assert.equal(snapshot.isCollapsed(), false);
	assert.equal(widget.render(80).length, 3, "再次点击恢复完整列表");
});

test("clicking an empty todo widget is not consumed", () => {
	const widget = new TodoWidget(new TodoSnapshot(), () => {
		throw new Error("空列表不应切换折叠状态");
	});
	assert.equal(click(widget, 0, 0), false);
});

test("completed todos toggle between the statusline and full checklist", () => {
	const snapshot = new TodoSnapshot();
	snapshot.update({
		tasks: TASKS.map((task) => ({ ...task, status: "completed" })),
	});
	assert.equal(snapshot.isStatuslineOnly(), true);
	assert.equal(snapshot.toggleCollapsed(), false);
	assert.equal(snapshot.isStatuslineOnly(), false);
	assert.equal(snapshot.toggleCollapsed(), true);
	assert.equal(snapshot.isStatuslineOnly(), true);
});

test("repeated completed snapshots retain an explicit expansion", () => {
	const snapshot = new TodoSnapshot();
	const done = TASKS.map((task) => ({ ...task, status: "completed" as const }));
	snapshot.replace(done);
	snapshot.toggleCollapsed();
	assert.equal(snapshot.isStatuslineOnly(), false);
	snapshot.replace(done);
	assert.equal(snapshot.isStatuslineOnly(), false);
	snapshot.replace(TASKS);
	assert.equal(snapshot.isStatuslineOnly(), false);
	snapshot.replace(done);
	assert.equal(snapshot.isStatuslineOnly(), true, "重新进入完成态时回到 statusline");
});

test("the widget renders from the snapshot, so a fold needs no re-mount", () => {
	const snapshot = new TodoSnapshot();
	const widget = new TodoWidget(snapshot, () => false);
	assert.deepEqual(widget.render(80), [], "还没有任务");
	snapshot.update({ tasks: TASKS });
	assert.equal(widget.render(80).length, 3, "同一个组件实例看得到新列表");
});

test("the same todo widget visually joins a live spinner and detaches afterward", () => {
	const snapshot = new TodoSnapshot();
	snapshot.update({ tasks: TASKS });
	let workingVisible = true;
	const widget = new TodoWidget(snapshot, () => false, () => workingVisible);

	assert.deepEqual(
		widget.render(80).map(strip),
		renderTodoBlock(TASKS, {
			indent: PINNED_WORKING_CHILD_INDENT,
			connector: true,
		}).map(strip),
		"运行中用 connector 接到 spinner 下方",
	);
	workingVisible = false;
	assert.deepEqual(
		widget.render(80).map(strip),
		renderTodoBlock(TASKS, {
			indent: PINNED_WORKING_CHILD_INDENT,
			connector: false,
		}).map(strip),
		"spinner 消失后同一个 component 切回 standalone",
	);
});

test("status, tool and Todo children align two columns after the spinner glyph", () => {
	assert.equal(workingMessageWidth(100, 80), 76);
	assert.equal(workingMessageWidth(60, 80), 60);
	const loader = new Loader(
		{ requestRender() {} } as any,
		(text) => text,
		(text) => text,
		"Working...\n  1.2s · ↑ 12k",
		{ frames: ["✽"], intervalMs: 1_000 },
	);
	const loaderRows = loader.render(80);
	loader.stop();
	const spinnerRow = loaderRows.find((row) => row.includes("✽")) ?? "";
	const statusRow = loaderRows.find((row) => row.includes("↑")) ?? "";
	const theme = {
		fg: (_color: string, text: string) => text,
	} as any;
	const toolRow = new WorkingToolsWidget(
		() => [{
			id: "read-1",
			groupId: "working",
			toolName: "read",
			args: { path: "src/a.ts" },
			status: "running",
			startedAt: 1_000,
		}],
		() => false,
		() => false,
		() => true,
		theme,
		() => 2_200,
	).render(80)[0] ?? "";

	const snapshot = new TodoSnapshot();
	snapshot.update({ tasks: TASKS });
	const todoRow = strip(
		new TodoWidget(snapshot, () => false, () => true).render(80)[0] ?? "",
	);
	assert.equal(spinnerRow.indexOf("✽"), WORKING_INDICATOR_COLUMN);
	assert.equal(statusRow.indexOf("1.2s"), WORKING_CHILD_COLUMN);
	assert.equal(toolRow.indexOf("└"), WORKING_CHILD_COLUMN);
	assert.equal(todoRow.indexOf("└"), WORKING_CHILD_COLUMN);
});

test("the widget keeps the unified child indentation between runs", () => {
	const snapshot = new TodoSnapshot();
	snapshot.update({ tasks: TASKS });
	const widget = new TodoWidget(snapshot, () => false);
	for (const row of widget.render(80)) {
		assert.ok(
			row.startsWith(PINNED_WORKING_CHILD_INDENT),
			`行没有统一子行缩进: ${JSON.stringify(row)}`,
		);
	}
	assert.deepEqual(
		widget.render(80).map(strip),
		renderTodoBlock(TASKS, {
			indent: PINNED_WORKING_CHILD_INDENT,
			connector: false,
		}).map(strip),
	);
});
