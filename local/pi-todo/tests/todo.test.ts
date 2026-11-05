import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function makePi() {
	const tools: any[] = [];
	const handlers = new Map<string, Handler[]>();
	const sent: any[] = [];
	const broadcasts: any[] = [];
	const snapshots: any[] = [];
	const channels: string[] = [];
	const busHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const api = {
		registerTool: (tool: any) => tools.push(tool),
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: {
			emit: (channel: string, payload: any) => {
				channels.push(channel);
				if (channel === "todo:changed") broadcasts.push(payload);
				if (channel === "todo:snapshot-v1") snapshots.push(payload);
				for (const handler of busHandlers.get(channel) ?? []) handler(payload);
			},
			on: (channel: string, handler: (payload: unknown) => void) => {
				const list = busHandlers.get(channel) ?? [];
				list.push(handler);
				busHandlers.set(channel, list);
				return () => {
					const index = list.indexOf(handler);
					if (index >= 0) list.splice(index, 1);
				};
			},
		},
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	};
	register(api as any);
	const fire = (event: string, payload: unknown = {}, ctx: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	return {
		tool: tools[0],
		sent,
		broadcasts,
		snapshots,
		channels,
		fire,
		emit: api.events.emit,
	};
}

function ctxWithEntries(entries: unknown[], sessionId?: string) {
	return {
		sessionManager: {
			buildContextEntries: () => entries,
			getSessionId: () => sessionId,
		},
	};
}

const LIST = [
	{ content: "Add schema", status: "completed", activeForm: "Adding schema" },
	{ content: "Write handler", status: "in_progress", activeForm: "Writing handler" },
	{ content: "Run tests", status: "pending", activeForm: "Running tests" },
];

test("status keeps a plain JSON enum in the tool schema", () => {
	const { tool } = makePi();
	const status = tool.parameters.properties.todos.items.properties.status;
	assert.deepEqual(status.enum, ["pending", "in_progress", "completed"]);
	assert.equal(status.anyOf, undefined);
});

test("execute replaces the list and echoes a snapshot with positional ids", async () => {
	const { tool } = makePi();
	const first = await tool.execute("t1", { todos: LIST });
	assert.equal(first.content[0].text, "1/3 completed · in progress: Write handler");
	assert.deepEqual(
		first.details.todos.map((t: any) => t.id),
		[1, 2, 3],
	);

	const second = await tool.execute("t2", {
		todos: [{ content: "Only task", status: "pending", activeForm: "Doing only task" }],
		explanation: "scope cut",
	});
	assert.equal(second.details.todos.length, 1);
	assert.equal(second.details.todos[0].id, 1);
	assert.equal(second.details.explanation, "scope cut");

	const cleared = await tool.execute("t3", { todos: [] });
	assert.equal(cleared.content[0].text, "Todo list cleared");
});

test("session_compact re-injects only while open work remains", async () => {
	const { tool, sent, fire } = makePi();

	await tool.execute("t1", { todos: [] });
	fire("session_compact");
	assert.equal(sent.length, 0);

	await tool.execute("t2", { todos: LIST });
	fire("session_compact");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "todo-state");
	assert.equal(sent[0].message.display, false);
	assert.match(sent[0].message.content, /\[~\] Write handler/);
	assert.equal(sent[0].message.details.todos.length, 3);

	await tool.execute("t3", {
		todos: LIST.map((t) => ({ ...t, status: "completed" })),
	});
	fire("session_compact");
	assert.equal(sent.length, 1);
});

test("session_start restores from the newest todo snapshot on the branch", async () => {
	const { tool, sent, fire } = makePi();
	const entries = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { todos: LIST.map((t, i) => ({ id: i + 1, ...t })) },
			},
		},
		{ type: "message", message: { role: "assistant" } },
	];
	fire("session_start", {}, ctxWithEntries(entries));
	fire("session_compact");
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /\[ \] Run tests/);
});

test("session_start restores the newest top-level post-compaction todo-state message", async () => {
	const { sent, fire } = makePi();
	const entries = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					todos: [{ id: 1, content: "Old task", status: "pending", activeForm: "Doing old task" }],
				},
			},
		},
		{
			type: "custom_message",
			customType: "todo-state",
			details: {
				todos: [{ id: 1, content: "Ship it", status: "in_progress", activeForm: "Shipping" }],
			},
		},
	];
	fire("session_start", {}, ctxWithEntries(entries));
	fire("session_compact");
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /\[~\] Ship it/);
	assert.doesNotMatch(sent[0].message.content, /Old task/);
});

test("session_start with no snapshot clears state", async () => {
	const { tool, sent, fire } = makePi();
	await tool.execute("t1", { todos: LIST });
	fire("session_start", {}, ctxWithEntries([]));
	fire("session_compact");
	assert.equal(sent.length, 0);
});

test("every list change broadcasts the full list on todo:changed", async () => {
	const { tool, broadcasts } = makePi();

	await tool.execute("t1", { todos: LIST });
	assert.equal(broadcasts.length, 1);
	assert.equal(broadcasts[0].todos.length, 3);
	assert.equal(broadcasts[0].todos[0].id, 1);
	assert.equal(broadcasts[0].todos[0].content, "Add schema");
	assert.equal(broadcasts[0].todos[0].status, "completed");

	await tool.execute("t2", { todos: [] });
	assert.deepEqual(broadcasts[1].todos, []);
});

test("the semantic owner does not also claim the Todo statusline slot", async () => {
	const { tool, channels } = makePi();
	await tool.execute("t1", { todos: LIST });
	assert.equal(channels.includes("statusline:row"), false);
});

test("publishes and serves a versioned semantic snapshot", async () => {
	const { tool, snapshots, fire, emit } = makePi();
	fire("session_start", {}, ctxWithEntries([], "session-1"));
	await tool.execute("t1", { todos: LIST });

	const latest = snapshots.at(-1);
	assert.equal(latest.version, 1);
	assert.equal(latest.sessionId, "session-1");
	assert.deepEqual(latest.todos[1], {
		id: 2,
		subject: "Write handler",
		status: "in_progress",
		activeForm: "Writing handler",
	});

	let reply: unknown;
	emit("todo:request:snapshot-v1", {
		sessionId: "session-1",
		reply: (payload: unknown) => {
			reply = payload;
		},
	});
	assert.deepEqual(reply, latest);

	reply = undefined;
	emit("todo:request:snapshot-v1", {
		sessionId: "another-session",
		reply: (payload: unknown) => {
			reply = payload;
		},
	});
	assert.equal(reply, undefined, "a scoped request cannot read another session");
});

test("failed restoration clears the old mirror without persisting or reinjecting it", async (t) => {
 const h=makePi();
 await h.tool.execute("old",{todos:LIST});
 const warnings:string[]=[];
 t.mock.method(console,"error",(message:unknown)=>warnings.push(String(message)));
 h.fire("session_start",{}, {sessionManager:{getSessionId:()=>"new-session",buildContextEntries:()=>{throw new Error("fixture failure");}}});
 assert.equal(h.snapshots.at(-1).sessionId,"new-session");
 assert.deepEqual(h.snapshots.at(-1).todos,[]);
 assert.equal(warnings.length,1);
 assert.match(warnings[0],/restore.*active.*branch/i);
 h.fire("session_compact");
 assert.equal(h.sent.length,0,"failure must not append an empty state or reinject old tasks");
});

test("input and restored snapshots are detached and projected to the three task fields", async () => {
 const h=makePi();
 const input:any[]=[{content:"Task",status:"pending",activeForm:"Doing task",id:999,extra:"ignored"}];
 const result=await h.tool.execute("write",{todos:input});
 assert.deepEqual(result.details.todos,[{id:1,content:"Task",status:"pending",activeForm:"Doing task"}]);
 input[0].content="mutated";input.push({...LIST[0]});
 result.details.todos[0].content="consumer mutation";
 let snapshot:any;
 h.emit("todo:request:snapshot-v1",{reply:(value:any)=>{snapshot=value;}});
 assert.deepEqual(snapshot.todos,[{id:1,subject:"Task",status:"pending",activeForm:"Doing task"}]);
 const saved:any[]=[{content:"Restored",status:"in_progress",activeForm:{bad:true},id:42},{content:"",status:"pending"}];
 h.fire("session_start",{},ctxWithEntries([
  {type:"message",message:{role:"toolResult",toolName:"todo",details:{todos:saved}}},
  {type:"message",message:{role:"toolResult",toolName:"todo",isError:true,details:{todos:[{content:"Failed write",status:"pending",activeForm:"Failing"}]}}},
 ],"restored-session"));
 saved[0].content="changed after restore";
 h.emit("todo:request:snapshot-v1",{sessionId:"restored-session",reply:(value:any)=>{snapshot=value;}});
 assert.deepEqual(snapshot.todos,[{id:1,subject:"Restored",status:"in_progress",activeForm:"Restored"}]);
});

test("collected todo stays in summary and restores its exact durable source on resume", () => {
 const h=makePi(),source:any={type:"custom_message",id:"todo-source",customType:"todo-state",details:{todos:LIST}};
 const compact:any={type:"compaction",id:"c",details:{recovery:{version:1,items:[{owner:"pi-todo",customType:"todo-state",identity:{sourceEntryId:source.id}}]}}};
 const ctx:any={sessionManager:{getSessionId:()=>"session",buildContextEntries:()=>[source],getBranch:()=>[source]}};
 h.fire("session_start",{},ctx);
 const replies:any[]=[];
 h.emit("pi-session-compact:collect-recovery-v1",{version:1,sessionId:"session",operationId:"op",reply:(item:any)=>replies.push(item)});
 assert.equal(replies.length,1);assert.match(replies[0].content,/Write handler/);assert.equal(replies[0].identity.sourceEntryId,source.id);
 h.fire("session_compact",{compactionEntry:compact},ctx);assert.equal(h.sent.length,0);
 ctx.sessionManager.buildContextEntries=()=>[compact];ctx.sessionManager.getBranch=()=>[source,compact];
 h.fire("session_start",{},ctx);
 assert.equal(h.snapshots.at(-1).todos[1].subject,"Write handler");
 h.fire("session_compact",{compactionEntry:{id:"legacy"}},ctx);assert.equal(h.sent.length,1);
});
