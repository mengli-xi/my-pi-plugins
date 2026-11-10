import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	Mail,
	MailboxBinding,
	MailboxCallbackFence,
	MailboxRunStart,
	ProducerEndpoint,
	ProducerRegistration,
} from "pi-session-inject/mailbox-v1";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { GoalCommandController } from "../src/commands.js";
import { GoalMailbox, goalIntentMail, goalMailKey, proveGoalMail } from "../src/mailbox.js";
import {
	neutralizeGoalMailboxCarrier,
	normalizeGoalMailboxForRollback,
} from "../src/mailbox-rollback.js";
import type { GoalRunIntent } from "../src/mailbox-state.js";
import {
	type ActiveGoal,
	type GoalStateEntryData,
	loadGoalStateFromSession,
} from "../src/persistence.js";
import { buildContinuePrompt } from "../src/prompts.js";
import { createGoal, GoalRuntime, transitionGoal } from "../src/runtime.js";

function fixture() {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const runtime = new GoalRuntime(mock.pi);
	runtime.activeGoal = createGoal("finish migration", undefined, 0);
	runtime.mailboxSessionId = "test-session";
	const branch: SessionEntry[] = [];
	const context = createMockContext({
		sessionManager: {
			getHeader: () => ({ id: "test-session" }),
			getSessionFile: () => "/tmp/test.jsonl",
			getBranch: () => branch,
			getEntries: () => branch,
			getLeafId: () => branch.at(-1)?.id ?? null,
		},
	});
	const append = mock.rawPi.appendEntry.bind(mock.rawPi);
	mock.rawPi.appendEntry = (customType, data) => {
		append(customType, data);
		branch.push({
			id: crypto.randomUUID(),
			parentId: branch.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			type: "custom",
			customType,
			data,
		});
	};
	const token = Symbol();
	const target = {
		slotKey: "slot",
		session: { id: "test-session", file: "/tmp/test.jsonl" },
		bindingGeneration: 1,
		producerToken: token,
	};
	const fence: MailboxCallbackFence = { ...target, ownerEpoch: 1, attemptId: "attempt" };
	const puts: Mail[] = [];
	const imports: string[] = [];
	const cancels: string[] = [];
	let callbacks!: ProducerRegistration;
	let cancel: () => Promise<void> = async () => {};
	let accept: () => Promise<void> = async () => {};
	const endpoint: ProducerEndpoint = {
		id: "pi-goal",
		token,
		target: () => target,
		async put(mail) {
			puts.push(mail);
			await accept();
			return { kind: "accepted", key: mail.key, revision: 1 };
		},
		async cancel(key, reason) {
			cancels.push(key);
			await cancel();
			return {
				producer: "pi-goal",
				key,
				terminalId: "cancelled",
				scope: { sessionId: "test-session", anchorEntryId: null },
				outcome: "cancelled",
				reason,
			};
		},
		async importFulfilled(mail, proof) {
			imports.push(mail.key);
			return {
				producer: "pi-goal",
				key: mail.key,
				terminalId: "fulfilled",
				scope: { sessionId: "test-session", anchorEntryId: null },
				outcome: "fulfilled",
				receiptEntryId: proof.sourceReceiptEntryId,
				assistantEntryId: proof.assistantEntryId,
				nativeEntryIds: [],
			};
		},
		async activateNewExecution() {
			throw new Error("Goal cannot activate a Subagent execution");
		},
		close() {},
	};
	const binding: MailboxBinding = {
		registerProducer(registration) {
			callbacks = registration;
			return endpoint;
		},
		close() {},
	};
	const mailbox = new GoalMailbox(runtime, mock.pi, {}, binding);
	runtime.mailbox = mailbox;
	const marker = `${runtime.activeGoal.id}:1:fixed`;
	const intent: GoalRunIntent = {
		goalId: runtime.activeGoal.id,
		marker,
		prompt: buildContinuePrompt(runtime.activeGoal, marker),
		anchorEntryId: "origin",
		sourceSessionId: "test-session",
		originEntryId: "origin",
		kind: "continue",
		started: false,
	};
	branch.push({
		id: "origin",
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType: "goal-state",
		data: {
			goal: runtime.activeGoal,
			mailbox: { intents: [structuredClone(intent)], cancelling: false },
		},
	});
	return {
		mock,
		runtime,
		branch,
		...context,
		mailbox,
		intent,
		puts,
		imports,
		cancels,
		fence,
		callbacks,
		setCancel(value: typeof cancel) {
			cancel = value;
		},
		setAccept(value: typeof accept) {
			accept = value;
		},
	};
}

test("put freezes the same logical custom carrier before acceptance without a native send", async () => {
	const f = fixture();
	let release!: () => void;
	f.setAccept(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const first = f.mailbox.submit(f.ctx, f.intent.goalId, f.intent.marker, f.intent.prompt);
	const second = f.mailbox.submit(f.ctx, f.intent.goalId, f.intent.marker, f.intent.prompt);
	assert.equal(f.puts.length, 1);
	assert.equal(f.runtime.mailboxState.intents[0]?.marker, f.intent.marker);
	assert.equal(f.mock.entries.at(-1)?.customType, "goal-state");
	assert.deepEqual(f.puts[0], goalIntentMail(f.intent));
	assert.equal(f.mock.sentUserMessages.length + f.mock.sentMessages.length, 0);
	release();
	assert.equal(await first, true);
	assert.equal(await second, true);
	assert.equal(f.runtime.activeGoal?.iteration, 0);
});

test("failed durable acceptance retains the frozen source intent and retries the same key", async () => {
	const f = fixture();
	f.setAccept(async () => {
		throw new Error("disk full");
	});
	assert.equal(
		await f.mailbox.submit(f.ctx, f.intent.goalId, f.intent.marker, f.intent.prompt),
		false,
	);
	assert.equal(f.runtime.mailboxState.intents.length, 1);
	assert.ok(f.notifications.some(({ message }) => message.includes("disk full")));
	f.setAccept(async () => {});
	await f.mailbox.restore(f.ctx);
	assert.equal(f.puts.length, 2);
	assert.deepEqual(f.puts[0], f.puts[1]);
	assert.equal(f.mock.sentUserMessages.length + f.mock.sentMessages.length, 0);
});

test("budget summary absorbs the next request while a legacy frozen budget policy stays unchanged", async () => {
	const fresh = fixture();
	await fresh.mailbox.submit(
		fresh.ctx,
		fresh.intent.goalId,
		fresh.intent.marker,
		fresh.intent.prompt,
		"budget",
	);
	assert.equal(fresh.puts[0]?.policy, "next-request");
	const old = fixture();
	old.intent.kind = "budget";
	old.runtime.mailboxState.intents.push(old.intent);
	old.branch[0] = {
		...old.branch[0],
		data: { mailbox: { intents: [structuredClone(old.intent)] } },
	} as SessionEntry;
	await old.mailbox.restore(old.ctx);
	assert.equal(old.puts[0]?.policy, "new-run");
});

test("public terminal receipt reconciles a natural USER run through A without borrowing its assistant proof", async () => {
	const f = fixture();
	f.runtime.mailboxState.intents.push(f.intent);
	const mail = goalIntentMail(f.intent);
	const evidence = {
		producer: "pi-goal" as const,
		key: mail.key,
		terminalId: "stable-terminal",
		scope: { sessionId: "test-session", anchorEntryId: mail.anchorEntryId },
		outcome: "fulfilled" as const,
		receiptEntryId: "delivery",
		assistantEntryId: "assistant",
		nativeEntryIds: ["body"],
	};
	f.branch.push({
		id: "user",
		type: "message",
		message: { role: "user", content: "USER" },
	} as SessionEntry);
	f.branch.push({
		id: "delivery",
		type: "custom",
		customType: "agent-mailbox-delivery-v1",
		data: {
			version: 1,
			sessionId: "test-session",
			terminals: [{ mail, branchEntryId: "origin", evidence }],
		},
	} as SessionEntry);
	f.mailbox.endpoint.put = async (observed) => {
		assert.deepEqual(observed, mail);
		assert.equal((await f.callbacks.checkCurrent(mail, "before-seal", f.fence)).kind, "hold");
		return { kind: "terminal", evidence };
	};
	await f.mailbox.restore(f.ctx);
	assert.equal(f.runtime.mailboxState.intents.length, 0);
	assert.equal(f.runtime.mailboxInvalid, false);
	assert.equal(f.imports.length, 0);
	assert.equal(f.runtime.activeGoal?.iteration, 0);
});

test("unconfirmed public terminal hint holds the key and retains the source intent", async () => {
	const f = fixture();
	f.runtime.mailboxState.intents.push(f.intent);
	const mail = goalIntentMail(f.intent);
	f.branch.push({
		id: "delivery",
		type: "custom",
		customType: "agent-mailbox-delivery-v1",
		data: {
			version: 1,
			sessionId: "test-session",
			terminals: [
				{
					mail,
					evidence: {
						producer: "pi-goal",
						key: mail.key,
						terminalId: "hint",
						scope: { sessionId: "test-session", anchorEntryId: mail.anchorEntryId },
						outcome: "cancelled",
					},
				},
			],
		},
	} as SessionEntry);
	f.setAccept(async () => {
		assert.equal((await f.callbacks.checkCurrent(mail, "before-seal", f.fence)).kind, "hold");
	});
	await f.mailbox.restore(f.ctx);
	assert.equal(f.runtime.mailboxState.intents.length, 1);
	assert.equal(f.runtime.mailboxInvalid, true);
	assert.equal(f.puts.length, 1);
	assert.equal(f.mock.sentMessages.length, 0);
});

test("native proof shares the legacy marker identity and rejects changed payload", () => {
	const f = fixture();
	const mail = goalIntentMail(f.intent);
	const legacy = {
		id: "user",
		parentId: null,
		type: "message",
		message: { role: "user", content: [{ type: "text", text: f.intent.prompt }] },
	} as SessionEntry;
	assert.deepEqual(proveGoalMail(mail, [legacy]), {
		kind: "observed",
		entries: [{ messageIndex: 0, entryId: "user" }],
	});
	const modified = structuredClone(legacy);
	if (modified.type === "message" && modified.message.role === "user")
		modified.message.content = `${f.intent.prompt} changed`;
	assert.equal(proveGoalMail(mail, [modified]).kind, "conflict");
});

test("native custom_message entries prove the new carrier without transcript role guessing", () => {
	const f = fixture();
	const mail = goalIntentMail(f.intent);
	const entry = {
		...mail.messages[0],
		id: "custom",
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom_message" as const,
	};
	assert.deepEqual(proveGoalMail(mail, [entry]), {
		kind: "observed",
		entries: [{ messageIndex: 0, entryId: "custom" }],
	});
	assert.equal(proveGoalMail(mail, [{ ...entry, content: "changed" }]).kind, "conflict");
});

test("marker acceptance clears only its exact owed marker and duplicate starts are idempotent", () => {
	const f = fixture();
	f.runtime.mailboxState.intents.push(f.intent);
	f.runtime.pendingBackgroundContinuation = {
		goalId: f.intent.goalId,
		continuationId: f.intent.marker,
		offerId: "offer",
		ownerId: "pi-processes",
		logicalKey: "batch",
		recordedAt: 1,
	};
	assert.equal(
		f.runtime.confirmContinuationDispatch(f.intent.prompt.replace(":fixed", ":other")),
		false,
	);
	const start = {
		members: [{ mail: goalIntentMail(f.intent), entries: [] }],
		automatic: true,
		ctx: f.ctx as ExtensionContext,
		fence: f.fence,
	} as unknown as MailboxRunStart;
	assert.equal(f.mailbox.start(start)?.duplicate, false);
	assert.equal(f.runtime.pendingBackgroundContinuation, undefined);
	assert.equal(f.mailbox.start(start)?.duplicate, true);
	assert.equal(f.runtime.activeGoal?.iteration, 0);
});

test("pause awaits durable cancellation, coalesces reentry and preserves the owed promise", async () => {
	const f = fixture();
	f.runtime.mailboxState.intents.push(f.intent);
	f.runtime.pendingBackgroundContinuation = {
		goalId: f.intent.goalId,
		continuationId: f.intent.marker,
		offerId: "offer",
		ownerId: "pi-processes",
		logicalKey: "batch",
		recordedAt: 1,
	};
	let release!: () => void;
	f.setCancel(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const commands = new GoalCommandController(f.runtime);
	const pause = commands.pauseGoal(f.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.runtime.activeGoal?.status, "active");
	assert.equal(f.runtime.mailboxState.cancelling, true);
	await commands.clearGoal(f.ctx);
	assert.equal(f.runtime.activeGoal?.status, "active");
	release();
	await pause;
	assert.equal(f.runtime.activeGoal?.status, "paused");
	assert.equal(f.runtime.pendingBackgroundContinuation?.continuationId, f.intent.marker);
	assert.deepEqual(f.cancels, [goalMailKey(f.intent.goalId, f.intent.marker)]);
});

test("cancel IO failure preserves visible pending authority and a replacement session is fenced", async () => {
	const f = fixture();
	f.runtime.mailboxState.intents.push(f.intent);
	f.setCancel(async () => {
		throw new Error("disk full");
	});
	await new GoalCommandController(f.runtime).pauseGoal(f.ctx);
	assert.equal(f.runtime.activeGoal?.status, "active");
	assert.equal(f.runtime.mailboxState.cancelling, true);
	assert.ok(f.notifications.some(({ message }) => /cancellation pending.*disk full/.test(message)));
	let release!: () => void;
	f.setCancel(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const pause = new GoalCommandController(f.runtime).pauseGoal(f.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	f.runtime.replaceMenuSession();
	f.runtime.activeGoal = createGoal("replacement", undefined, 0);
	release();
	await pause;
	assert.equal(f.runtime.activeGoal.text, "replacement");
	assert.equal(f.runtime.activeGoal.status, "active");
});

for (const kind of ["advance", "prioritize"] as const) {
	for (const recovery of ["settled", "restart"] as const) {
		test(`${kind} keeps its persisted action when cancellation fails and retries after ${recovery}`, async () => {
			const f = fixture();
			assert.ok(f.runtime.activeGoal);
			f.runtime.mailboxState.intents.push(f.intent);
			if (kind === "advance")
				f.runtime.activeGoal = transitionGoal(f.runtime.activeGoal, "complete");
			f.runtime.queuedGoals = [transitionGoal(createGoal("next goal", undefined, 0), "queued")];
			const pending =
				kind === "advance"
					? {
							kind,
							goalId: f.intent.goalId,
							reason: "complete" as const,
							completedText: "finish migration",
						}
					: {
							kind,
							objective: "urgent goal",
							tokenBudget: undefined,
							displacedUsageFinalized: true,
						};
			f.runtime.pendingQueueAction = pending;
			f.setCancel(async () => {
				throw new Error("disk full");
			});
			assert.equal(
				await new GoalCommandController(f.runtime).dispatchPendingQueueActionIfSettled(f.ctx),
				false,
			);
			assert.equal(f.runtime.pendingQueueAction, pending);
			const data = f.mock.entries.at(-1)?.data;
			const loaded = loadGoalStateFromSession({
				sessionManager: { getBranch: () => [{ type: "custom", customType: "goal-state", data }] },
			});
			assert.deepEqual(loaded.pendingAction, pending);
			assert.equal(loaded.mailbox?.cancelling, true);

			const resumed = recovery === "settled" ? f : fixture();
			if (recovery === "restart") {
				resumed.branch.splice(0, resumed.branch.length, ...structuredClone(f.branch));
				resumed.runtime.activeGoal = loaded.goal;
				resumed.runtime.queuedGoals = loaded.queue;
				resumed.runtime.pendingQueueAction = loaded.pendingAction;
				resumed.runtime.mailboxState = loaded.mailbox ?? { intents: [], cancelling: false };
			}
			resumed.setCancel(async () => {});
			assert.equal(
				await new GoalCommandController(resumed.runtime).dispatchPendingQueueActionIfSettled(
					resumed.ctx,
				),
				true,
			);
			assert.equal(
				resumed.runtime.activeGoal?.text,
				kind === "advance" ? "next goal" : "urgent goal",
			);
			assert.equal(resumed.runtime.pendingQueueAction, undefined);
		});
	}
}

for (const command of ["clearGoal", "dropLastGoal", "skipGoal"] as const) {
	test(`${command} rejects a failed cancellation without announcing success`, async () => {
		const f = fixture();
		f.runtime.mailboxState.intents.push(f.intent);
		f.setCancel(async () => {
			throw new Error("disk full");
		});
		assert.equal(await new GoalCommandController(f.runtime)[command](f.ctx), false);
		assert.equal(f.runtime.activeGoal?.id, f.intent.goalId);
		assert.equal(f.runtime.mailboxState.cancelling, true);
		assert.ok(f.notifications.some(({ message }) => message.includes("cancellation pending")));
		assert.equal(
			f.notifications.some(({ message }) => /^Goal (cleared|dropped|skipped):/.test(message)),
			false,
		);
	});

	test(`${command} reports success only for the clearing call during concurrent reentry`, async () => {
		const f = fixture();
		f.runtime.mailboxState.intents.push(f.intent);
		let release!: () => void;
		f.setCancel(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const commands = new GoalCommandController(f.runtime);
		const first = commands[command](f.ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(await commands[command](f.ctx), false);
		assert.equal(f.runtime.activeGoal?.id, f.intent.goalId);
		assert.equal(
			f.notifications.some(({ message }) => /^Goal (cleared|dropped|skipped):/.test(message)),
			false,
		);
		release();
		assert.equal(await first, true);
		assert.equal(f.runtime.activeGoal, undefined);
		assert.equal(
			f.notifications.filter(({ message }) => /^Goal (cleared|dropped|skipped):/.test(message))
				.length,
			1,
		);
		assert.equal(f.cancels.length, 1);
	});
}

test("paused and budget guards do not authorize Goal advancement", async () => {
	const f = fixture();
	f.runtime.mailboxState.intents.push(f.intent);
	assert.ok(f.runtime.activeGoal);
	f.runtime.activeGoal = transitionGoal(f.runtime.activeGoal, "paused");
	assert.equal(
		(await f.callbacks.checkCurrent(goalIntentMail(f.intent), "before-seal", f.fence)).kind,
		"hold",
	);
	f.runtime.activeGoal.status = "active";
	f.runtime.activeGoal.tokenBudget = 1;
	f.runtime.activeGoal.tokensUsed = 1;
	assert.equal(
		(await f.callbacks.checkCurrent(goalIntentMail(f.intent), "before-native-send", f.fence)).kind,
		"hold",
	);
	f.runtime.activeGoal = undefined;
	assert.equal(
		(await f.callbacks.checkCurrent(goalIntentMail(f.intent), "before-seal", f.fence)).kind,
		"cancel",
	);
	f.intent.sourceSessionId = "parent-session";
	assert.equal(
		(await f.callbacks.checkCurrent(goalIntentMail(f.intent), "before-seal", f.fence)).kind,
		"hold",
	);
});

test("a recorded custom start imports only with its own source checkpoint and successful assistant", async () => {
	const f = fixture();
	const started = { ...f.intent, started: true };
	f.runtime.mailboxState.intents.push(started);
	const carrier = goalIntentMail(started).messages[0];
	assert.ok(carrier);
	f.branch.push(
		{
			id: "checkpoint",
			parentId: null,
			type: "custom",
			customType: "goal-state",
			timestamp: "2026-10-24T00:00:00Z",
			data: { goal: f.runtime.activeGoal, mailbox: { intents: [started], cancelling: false } },
		},
		{
			...carrier,
			id: "carrier",
			parentId: "checkpoint",
			type: "custom_message",
			timestamp: "2026-10-24T00:00:01Z",
		},
		{
			id: "assistant",
			parentId: "carrier",
			type: "message",
			message: { role: "assistant", stopReason: "stop", content: [] },
		} as unknown as SessionEntry,
	);
	await f.mailbox.restore(f.ctx);
	assert.deepEqual(f.imports, [goalMailKey(started.goalId, started.marker)]);
	assert.equal(f.puts.length, 0);
	assert.equal(f.runtime.mailboxState.intents.length, 0);
});

for (const boundary of ["own-control", "unrelated-custom", "unproven-control"] as const) {
	test(`custom success import observes ${boundary} attribution`, async () => {
		const f = fixture();
		const started = { ...f.intent, started: true };
		f.runtime.mailboxState.intents.push(started);
		const carrier = goalIntentMail(started).messages[0];
		assert.ok(carrier);
		const key = goalMailKey(started.goalId, started.marker);
		f.branch.push(
			{
				id: "checkpoint",
				parentId: null,
				type: "custom",
				customType: "goal-state",
				timestamp: "2026-10-24T00:00:00Z",
				data: { goal: f.runtime.activeGoal, mailbox: { intents: [started], cancelling: false } },
			},
			{
				...carrier,
				id: "carrier",
				parentId: "checkpoint",
				type: "custom_message",
				timestamp: "2026-10-24T00:00:01Z",
			},
			{
				id: "attempt",
				parentId: "carrier",
				type: "custom",
				customType: "agent-mailbox-attempt-v1",
				timestamp: "2026-10-24T00:00:02Z",
				data: {
					version: 1,
					sessionId: "test-session",
					id: "own-attempt",
					sealedRevision: 1,
					members: [
						{
							producer: "pi-goal",
							key: boundary === "unproven-control" ? "other-key" : key,
							anchorEntryId: started.anchorEntryId,
						},
					],
				},
			},
			{
				id: "control",
				parentId: "attempt",
				type: "custom_message",
				customType: "agent-mailbox-trigger-v1",
				display: false,
				content: "Process admitted mail.",
				timestamp: "2026-10-24T00:00:03Z",
				details: { version: 1, sessionId: "test-session", attemptId: "own-attempt" },
			},
		);
		if (boundary === "unrelated-custom")
			f.branch.push({
				id: "unrelated",
				parentId: "control",
				type: "custom_message",
				customType: "other-request",
				display: false,
				content: "Unrelated work",
				timestamp: "2026-10-24T00:00:04Z",
			});
		f.branch.push({
			id: "assistant",
			parentId: f.branch.at(-1)?.id,
			type: "message",
			message: { role: "assistant", stopReason: "stop", content: [] },
		} as unknown as SessionEntry);
		await f.mailbox.restore(f.ctx);
		assert.deepEqual(f.imports, boundary === "own-control" ? [key] : []);
		assert.equal(f.puts.length, 0);
		assert.equal(f.runtime.mailboxState.intents.length, boundary === "own-control" ? 0 : 1);
		assert.equal(f.runtime.mailboxInvalid, boundary !== "own-control");
		assert.equal(f.mock.sentUserMessages.length + f.mock.sentMessages.length, 0);
	});
}

test("legacy user start plus success clears owed locally with zero mailbox sends or model calls", async () => {
	const f = fixture();
	f.runtime.pendingBackgroundContinuation = {
		goalId: f.intent.goalId,
		continuationId: f.intent.marker,
		offerId: "offer",
		ownerId: "pi-processes",
		logicalKey: "batch",
		recordedAt: 1,
	};
	f.branch.push(
		{
			id: "user",
			parentId: null,
			type: "message",
			message: { role: "user", content: f.intent.prompt },
		} as SessionEntry,
		{
			id: "assistant",
			parentId: "user",
			type: "message",
			message: { role: "assistant", stopReason: "stop", content: [] },
		} as unknown as SessionEntry,
	);
	await f.mailbox.restore(f.ctx);
	assert.equal(f.runtime.pendingBackgroundContinuation, undefined);
	assert.equal(f.puts.length + f.imports.length, 0);
	assert.equal(f.mock.sentMessages.length + f.mock.sentUserMessages.length, 0);
	assert.equal(f.runtime.activeGoal?.iteration, 0);
});

test("even a source start checkpoint never sends an old user carrier to importFulfilled", async () => {
	const f = fixture();
	const started = { ...f.intent, started: true };
	f.runtime.mailboxState.intents.push(started);
	f.branch.push(
		{
			id: "checkpoint",
			parentId: null,
			type: "custom",
			customType: "goal-state",
			timestamp: "2026-10-24T00:00:00Z",
			data: { goal: f.runtime.activeGoal, mailbox: { intents: [started], cancelling: false } },
		},
		{
			id: "user",
			parentId: "checkpoint",
			type: "message",
			message: { role: "user", content: started.prompt },
		} as SessionEntry,
		{
			id: "assistant",
			parentId: "user",
			type: "message",
			message: { role: "assistant", stopReason: "stop", content: [] },
		} as unknown as SessionEntry,
	);
	await f.mailbox.restore(f.ctx);
	assert.equal(f.imports.length + f.puts.length, 0);
	assert.equal(f.runtime.mailboxInvalid, true);
});

test("legacy success from a later user is unknown and never creates a second wake", async () => {
	const f = fixture();
	f.runtime.pendingBackgroundContinuation = {
		goalId: f.intent.goalId,
		continuationId: f.intent.marker,
		offerId: "offer",
		ownerId: "pi-processes",
		logicalKey: "batch",
		recordedAt: 1,
	};
	f.branch.push(
		{
			id: "user",
			parentId: null,
			type: "message",
			message: { role: "user", content: f.intent.prompt },
		} as SessionEntry,
		{
			id: "later",
			parentId: "user",
			type: "message",
			message: { role: "user", content: "unrelated" },
		} as SessionEntry,
		{
			id: "assistant",
			parentId: "later",
			type: "message",
			message: { role: "assistant", stopReason: "stop", content: [] },
		} as unknown as SessionEntry,
	);
	await f.mailbox.restore(f.ctx);
	assert.equal(f.runtime.mailboxInvalid, true);
	assert.equal(f.puts.length + f.imports.length, 0);
	assert.equal(f.runtime.pendingBackgroundContinuation?.continuationId, f.intent.marker);
});

test("offline rollback changes only selected source markers and new custom carriers", () => {
	const f = fixture();
	const other = { ...f.intent, marker: `${f.intent.goalId}:other`, prompt: "other" };
	assert.ok(f.runtime.activeGoal);
	const state = {
		goal: f.runtime.activeGoal,
		mailbox: { intents: [f.intent, other], cancelling: false },
		pendingContinuation: {
			goalId: f.intent.goalId,
			continuationId: f.intent.marker,
			offerId: "offer",
			ownerId: "pi-processes",
			logicalKey: "batch",
			recordedAt: 1,
		},
	};
	const key = goalMailKey(f.intent.goalId, f.intent.marker);
	const normalized = normalizeGoalMailboxForRollback(state, [key]);
	assert.equal(normalized.goal?.status, "paused");
	assert.equal(normalized.pendingContinuation, undefined);
	assert.deepEqual(normalized.mailbox?.intents, [other]);
	const legacy = { role: "user", content: f.intent.prompt };
	assert.equal(neutralizeGoalMailboxCarrier(legacy, [key]), legacy);
	const carrier = goalIntentMail(f.intent).messages[0];
	assert.ok(carrier);
	assert.equal(
		neutralizeGoalMailboxCarrier(carrier, [key]).customType,
		"goal-mailbox-abandoned-v1",
	);
	const clean = normalizeGoalMailboxForRollback(normalized, [
		goalMailKey(other.goalId, other.marker),
	]);
	assert.equal(clean.mailbox, undefined);
	assert.equal(
		loadGoalStateFromSession({
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: "goal-state", data: clean }],
			},
		}).goal?.status,
		"paused",
	);
});

for (const transport of ["owed", "intent", "both"] as const) {
	test(`offline rollback preserves recorded usage for ${transport} through reopen and resume`, (t) => {
		let now = 200_000_000;
		t.mock.method(Date, "now", () => now);
		const f = fixture();
		assert.ok(f.runtime.activeGoal);
		const goal = {
			...f.runtime.activeGoal,
			startedAt: 1,
			updatedAt: 2,
			activeStartedAt: 3,
			iteration: 4,
			tokensUsed: 123,
			baselineTokens: 7,
			tokenBudget: 2_000,
			timeUsedSeconds: transport === "owed" ? 0 : 12.75,
			automaticModelTurns: 2,
			toolFreeRepeatCount: 1,
		};
		const state: GoalStateEntryData = {
			goal,
			...(transport !== "owed" ? { mailbox: { intents: [f.intent], cancelling: false } } : {}),
			...(transport !== "intent"
				? {
						pendingContinuation: {
							goalId: goal.id,
							continuationId: f.intent.marker,
							offerId: "offer",
							ownerId: "pi-processes",
							logicalKey: "batch",
							recordedAt: 1,
						},
					}
				: {}),
		};
		const original = structuredClone(state);
		assert.deepEqual(normalizeGoalMailboxForRollback(state, ["unselected"]), original);
		const normalized = normalizeGoalMailboxForRollback(state, [
			goalMailKey(f.intent.goalId, f.intent.marker),
		]);
		const expectedGoal: ActiveGoal = { ...goal, status: "paused" };
		delete expectedGoal.activeStartedAt;
		assert.deepEqual(normalized, { goal: expectedGoal });
		assert.deepEqual(state, original);

		// A persisted pause has no clock to checkpoint when a later process resumes it.
		now += 100_000_000;
		const reopened = loadGoalStateFromSession({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "goal-state",
						data: JSON.parse(JSON.stringify(normalized)),
					},
				],
			},
		});
		assert.ok(reopened.goal);
		assert.equal(reopened.goal.activeStartedAt, undefined);
		assert.equal(reopened.pendingContinuation, undefined);
		const resumed = transitionGoal(reopened.goal, "active");
		assert.equal(resumed.timeUsedSeconds, goal.timeUsedSeconds);
		assert.equal(resumed.activeStartedAt, now);
		now += 2_500;
		assert.equal(transitionGoal(resumed, "paused").timeUsedSeconds, goal.timeUsedSeconds + 2.5);
	});
}
