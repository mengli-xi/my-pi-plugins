import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	bindMailbox,
	type Mail,
	type MailboxBinding,
	parseMailboxSnapshot,
} from "pi-session-inject/mailbox-v1";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { GoalMailbox, goalIntentMail, goalMailKey } from "../src/mailbox.js";
import type { GoalRunIntent } from "../src/mailbox-state.js";
import { loadGoalStateFromSession } from "../src/persistence.js";
import { createGoal, GoalRuntime, transitionGoal } from "../src/runtime.js";

/** Real A1 store/binding/SessionManager; the event source controls only tree and
 * source-work timing. Provider behavior is separately tested with stock Pi. */
async function harness() {
	const directory = await mkdtemp(join(tmpdir(), "goal-mailbox-a1-tree-"));
	const cwd = join(directory, "cwd"),
		agentDir = join(directory, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const manager = SessionManager.create(cwd, join(directory, "sessions"));
	manager.appendMessage({ role: "user", content: "initial", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("Initial source checkpoint is persisted."));
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const sourceInfo = {
		path: "goal-tree-test",
		source: "goal-tree-test",
		scope: "temporary",
		origin: "top-level",
	};
	const on = mock.rawPi.on.bind(mock.rawPi);
	mock.rawPi.on = (name, callback) => {
		on(name, callback);
		return () => {
			const list = mock.events.get(name);
			const index = list?.indexOf(callback) ?? -1;
			if (index >= 0) list?.splice(index, 1);
		};
	};
	Object.assign(mock.rawPi, {
		getCommands: () =>
			[...mock.commands].map(([name, definition]) => ({
				name,
				description: definition.description,
				sourceInfo,
				source: "extension",
			})),
	});
	mock.rawPi.appendEntry = (customType, data) => {
		manager.appendCustomEntry(customType, data);
	};
	const context = createMockContext({ cwd });
	Object.assign(context.ctx, { sessionManager: manager });
	let binding = bindMailbox(mock.pi, { agentDir });
	let delay: Promise<void> | undefined;
	const puts: Mail[] = [];
	const sourceBinding: MailboxBinding = {
		registerProducer(callbacks) {
			const endpoint = binding.registerProducer(callbacks);
			return {
				...endpoint,
				async put(mail, target, options) {
					puts.push(structuredClone(mail));
					const wait = delay;
					delay = undefined;
					if (wait) await wait;
					return endpoint.put(mail, target, options);
				},
			};
		},
		close: () => binding.close(),
	};
	const runtime = new GoalRuntime(mock.pi);
	runtime.activeGoal = createGoal("stay on the origin branch", undefined, 0);
	runtime.mailboxSessionId = manager.getSessionId();
	runtime.persistGoal(runtime.activeGoal);
	const shared = manager.getLeafId();
	assert.ok(shared);
	const sibling = manager.appendMessage({
		role: "user",
		content: "sibling",
		timestamp: Date.now(),
	});
	manager.branch(shared);
	manager.appendMessage({ role: "user", content: "origin", timestamp: Date.now() });
	const mailbox = new GoalMailbox(runtime, mock.pi, {}, sourceBinding);
	runtime.mailbox = mailbox;
	async function emit(name: string, event: object = {}) {
		const results = [];
		for (const callback of [...(mock.events.get(name) ?? [])])
			results.push(await callback({ type: name, ...event }, context.ctx));
		return results;
	}
	async function navigate(leaf: string) {
		const results = await emit("session_before_tree");
		assert.ok(
			!results.some(
				(result) => result && typeof result === "object" && Reflect.get(result, "cancel"),
			),
		);
		const outgoing = manager.getLeafId();
		assert.ok(outgoing);
		manager.branch(leaf);
		await emit("session_tree");
		runtime.replaceMenuSession();
		runtime.clearContinuationTracking();
		const loaded = loadGoalStateFromSession(context.ctx);
		runtime.activeGoal = loaded.goal;
		runtime.mailboxState = loaded.mailbox ?? { intents: [], cancelling: false };
		runtime.pendingBackgroundContinuation = loaded.pendingContinuation;
		return outgoing;
	}
	await emit("session_start", { reason: "startup" });
	const snapshot = async () => {
		try {
			return parseMailboxSnapshot(
				JSON.parse(
					await readFile(
						join(agentDir, "mailbox/v1", manager.getSessionId(), "pending.json"),
						"utf8",
					),
				),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return parseMailboxSnapshot({
				version: 1,
				session: { id: manager.getSessionId(), file: manager.getSessionFile(), cwd },
				revision: 0,
				suspended: null,
				pending: [],
				terminal: [],
			});
		}
	};
	return {
		runtime,
		mailbox,
		manager,
		ctx: context.ctx as ExtensionContext,
		mock,
		puts,
		shared,
		sibling,
		navigate,
		snapshot,
		async reloadBinding() {
			binding.close();
			binding = bindMailbox(mock.pi, { agentDir });
			const replacement = new GoalMailbox(runtime, mock.pi, {}, sourceBinding);
			runtime.mailbox = replacement;
			await emit("session_start", { reason: "reload" });
			return replacement;
		},
		delayPut(promise: Promise<void>) {
			delay = promise;
		},
		async cleanup() {
			await emit("session_shutdown", { reason: "quit" });
			binding.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("A1 fences a tree-stale unaccepted Goal put and origin reconstruction retries the same frozen mail", async () => {
	const h = await harness();
	let release!: () => void;
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const goalId = h.runtime.activeGoal.id,
			marker = `${goalId}:1:tree`;
		h.delayPut(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const pending = h.mailbox.submit(
			h.ctx,
			goalId,
			marker,
			`continue\n<!-- pi-goal-continuation:${marker} -->`,
		);
		const original = structuredClone(h.puts[0]);
		const origin = await h.navigate(h.sibling);
		release();
		assert.equal(await pending, false);
		assert.equal((await h.snapshot()).pending.length, 0);
		await h.mailbox.restore(h.ctx);
		assert.equal(h.puts.length, 1, "sibling does not recapture and resend an old intent");
		await h.navigate(origin);
		await h.mailbox.restore(h.ctx);
		assert.deepEqual(h.puts[1], original);
		assert.equal((await h.snapshot()).pending[0]?.key, goalMailKey(goalId, marker));
	} finally {
		release?.();
		await h.cleanup();
	}
});

test("same-session owner reload retains one unconfirmed idle control for the pending Goal", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		const goalId = h.runtime.activeGoal.id,
			marker = `${goalId}:1:reload`;
		await h.mailbox.submit(
			h.ctx,
			goalId,
			marker,
			`continue\n<!-- pi-goal-continuation:${marker} -->`,
		);
		const until = async (predicate: () => boolean) => {
			const deadline = Date.now() + 3000;
			while (!predicate()) {
				assert.ok(Date.now() < deadline, "real A1 native submission deadline");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		};
		await until(() => h.mock.sentMessages.length === 1);
		const original = structuredClone(h.mock.sentMessages);
		const mailbox = await h.reloadBinding();
		await mailbox.restore(h.ctx);
		assert.deepEqual(h.mock.sentMessages, original);
		assert.equal((await h.snapshot()).pending.length, 1);
		assert.equal(h.runtime.mailboxState.intents.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("a lost first-checkpoint reply recovers the exact source edge and can cancel without a second origin write", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const id = h.runtime.activeGoal.id,
			marker = `${id}:1:checkpoint`;
		const append = h.mock.rawPi.appendEntry.bind(h.mock.rawPi);
		let writes = 0;
		h.mock.rawPi.appendEntry = (type, data) => {
			append(type, data);
			if (
				type === "goal-state" &&
				(data as { mailbox?: { intents: unknown[] } }).mailbox?.intents.length &&
				++writes === 1
			)
				throw new Error("source checkpoint persisted but reply lost");
		};
		await assert.rejects(
			h.mailbox.submit(h.ctx, id, marker, `continue\n<!-- pi-goal-continuation:${marker} -->`),
			/reply lost/,
		);
		const loaded = loadGoalStateFromSession(h.ctx);
		const frozen = structuredClone(loaded.mailbox?.intents[0]);
		assert.equal(frozen?.originEntryId, undefined);
		assert.equal(frozen?.sourceSessionId, h.manager.getSessionId());
		assert.equal((await h.snapshot()).pending.length, 0);
		h.runtime.mailboxState = loaded.mailbox ?? { intents: [], cancelling: false };
		const replacement = await h.reloadBinding();
		await replacement.restore(h.ctx);
		assert.equal(
			h.runtime.mailboxState.intents[0]?.originEntryId,
			h.manager
				.getBranch()
				.find(
					(entry) =>
						entry.parentId === frozen?.anchorEntryId &&
						entry.type === "custom" &&
						entry.customType === "goal-state",
				)?.id,
		);
		assert.deepEqual(
			goalIntentMail(h.runtime.mailboxState.intents[0] as GoalRunIntent),
			goalIntentMail(frozen as GoalRunIntent),
		);
		await replacement.cancelGoal(h.ctx, id);
		assert.equal((await h.snapshot()).pending.length, 0);
		assert.equal((await h.snapshot()).terminal[0]?.evidence.outcome, "cancelled");
	} finally {
		await h.cleanup();
	}
});

test("origin creation needs only one source append before durable mailbox acceptance", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const append = h.mock.rawPi.appendEntry.bind(h.mock.rawPi);
		let writes = 0;
		h.mock.rawPi.appendEntry = (type, data) => {
			if (
				type === "goal-state" &&
				(data as { mailbox?: { intents: unknown[] } }).mailbox?.intents.length &&
				++writes === 2 &&
				h.puts.length === 0
			)
				throw new Error("second pre-acceptance source write failed");
			append(type, data);
		};
		const id = h.runtime.activeGoal.id,
			marker = `${id}:1:single-write`;
		assert.equal(
			await h.mailbox.submit(
				h.ctx,
				id,
				marker,
				`continue\n<!-- pi-goal-continuation:${marker} -->`,
			),
			true,
		);
		assert.equal(writes, 1);
		assert.equal((await h.snapshot()).pending.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("a source append that wrote nothing retries only its unchanged live origin", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const append = h.mock.rawPi.appendEntry.bind(h.mock.rawPi);
		let fail = true;
		h.mock.rawPi.appendEntry = (type, data) => {
			if (
				fail &&
				type === "goal-state" &&
				(data as { mailbox?: { intents: unknown[] } }).mailbox?.intents.length
			)
				throw new Error("source append failed before write");
			append(type, data);
		};
		const id = h.runtime.activeGoal.id,
			marker = `${id}:1:no-write`,
			prompt = `continue\n<!-- pi-goal-continuation:${marker} -->`;
		await assert.rejects(h.mailbox.submit(h.ctx, id, marker, prompt), /before write/);
		assert.equal(h.puts.length, 0);
		fail = false;
		assert.equal(await h.mailbox.submit(h.ctx, id, marker, prompt), true);
		assert.equal((await h.snapshot()).pending[0]?.key, goalMailKey(id, marker));
	} finally {
		await h.cleanup();
	}
});

test("forked entry IDs confer no source session authority, including unscoped legacy state", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const id = h.runtime.activeGoal.id,
			marker = `${id}:1:fork`;
		await h.mailbox.submit(h.ctx, id, marker, `continue\n<!-- pi-goal-continuation:${marker} -->`);
		const loaded = loadGoalStateFromSession(h.ctx),
			count = h.puts.length;
		const fork = SessionManager.forkFrom(
			h.manager.getSessionFile() as string,
			h.ctx.cwd,
			h.manager.getSessionDir(),
		);
		const forkCtx = { ...h.ctx, sessionManager: fork };
		h.runtime.mailboxSessionId = fork.getSessionId();
		h.runtime.mailboxState = structuredClone(loaded.mailbox ?? { intents: [], cancelling: false });
		await h.mailbox.restore(forkCtx);
		await h.mailbox.cancelGoal(forkCtx, id);
		assert.equal(h.puts.length, count);
		const intent = h.runtime.mailboxState.intents[0];
		assert.ok(intent);
		delete intent.sourceSessionId;
		await h.mailbox.restore(forkCtx);
		assert.equal(h.runtime.mailboxInvalid, true);
		await assert.rejects(h.mailbox.cancelGoal(forkCtx, id), /original source scope/);
		assert.equal(h.puts.length, count);
		h.runtime.mailboxSessionId = h.manager.getSessionId();
		h.runtime.mailboxInvalid = false;
		h.runtime.mailboxState = loaded.mailbox ?? { intents: [], cancelling: false };
		await h.mailbox.restore(h.ctx);
		assert.equal(h.puts.length, count + 1);
	} finally {
		await h.cleanup();
	}
});

test("an already registered Goal transaction stays on its origin across tree and is never resubmitted to sibling", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const goalId = h.runtime.activeGoal.id,
			marker = `${goalId}:1:registered`;
		const pending = h.mailbox.submit(
			h.ctx,
			goalId,
			marker,
			`continue\n<!-- pi-goal-continuation:${marker} -->`,
		);
		const original = structuredClone(h.puts[0]);
		const origin = await h.navigate(h.sibling);
		assert.equal(await pending, true);
		await h.mailbox.restore(h.ctx);
		assert.equal(h.puts.length, 1);
		const snapshot = await h.snapshot();
		assert.equal(snapshot.pending.length, 1);
		assert.equal(
			h.manager.getBranch().some((entry) => entry.id === snapshot.pending[0]?.branchEntryId),
			false,
		);
		await h.navigate(origin);
		await h.mailbox.restore(h.ctx);
		assert.deepEqual(h.puts[1], original);
		assert.equal((await h.snapshot()).pending.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("an old Goal dispatch cannot create a target on a same-Goal sibling after an awaited safety guard", async () => {
	const h = await harness();
	let release!: () => void;
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.requestContinuation(h.runtime.activeGoal);
		h.runtime.enforceAutomaticTurnLimit = async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return false;
		};
		const pending = h.runtime.dispatchContinuationIfSettled(h.ctx);
		await h.navigate(h.sibling);
		release();
		assert.equal(await pending, false);
		assert.equal(h.puts.length, 0);
		assert.equal(h.runtime.mailboxState.intents.length, 0);
	} finally {
		release?.();
		await h.cleanup();
	}
});

test("shared anchor and Goal identity cannot authorize sibling restore or cancellation", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const goalId = h.runtime.activeGoal.id,
			marker = `${goalId}:1:shared`;
		const intent: GoalRunIntent = {
			goalId,
			marker,
			prompt: `continue\n<!-- pi-goal-continuation:${marker} -->`,
			anchorEntryId: h.shared,
			sourceSessionId: h.manager.getSessionId(),
			kind: "continue",
			started: false,
		};
		h.runtime.mailboxState.intents.push(intent);
		h.runtime.persistGoal(h.runtime.activeGoal);
		intent.originEntryId = h.manager.getLeafId() ?? undefined;
		assert.ok(intent.originEntryId);
		h.runtime.persistGoal(h.runtime.activeGoal);
		assert.equal(await h.mailbox.submit(h.ctx, goalId, marker, intent.prompt), true);
		const original = structuredClone(h.puts[0]);
		const origin = await h.navigate(h.sibling);
		h.runtime.mailboxState.intents.push(structuredClone(intent));
		assert.ok(h.manager.getBranch().some((entry) => entry.id === intent.anchorEntryId));
		await h.mailbox.restore(h.ctx);
		assert.equal(h.puts.length, 1);
		await assert.rejects(h.mailbox.cancelGoal(h.ctx, goalId), /original source scope/);
		assert.equal(h.puts.length, 1);
		assert.equal((await h.snapshot()).pending.length, 1);
		await h.navigate(origin);
		await h.mailbox.cancelGoal(h.ctx, goalId);
		const terminal = await h.mailbox.endpoint.put(original);
		assert.equal(terminal.kind, "terminal");
		if (terminal.kind === "terminal") assert.equal(terminal.evidence.outcome, "cancelled");
	} finally {
		await h.cleanup();
	}
});

test("legacy Goal intent without origin is held until its exact canonical carrier proves the branch", async () => {
	const h = await harness();
	try {
		assert.ok(h.runtime.activeGoal);
		h.runtime.activeGoal = transitionGoal(h.runtime.activeGoal, "paused");
		const goalId = h.runtime.activeGoal.id,
			marker = `${goalId}:1:legacy`;
		const intent: GoalRunIntent = {
			goalId,
			marker,
			prompt: `continue\n<!-- pi-goal-continuation:${marker} -->`,
			anchorEntryId: h.shared,
			kind: "continue",
			started: false,
		};
		h.runtime.mailboxState.intents.push(intent);
		h.runtime.persistGoal(h.runtime.activeGoal);
		await h.mailbox.restore(h.ctx);
		assert.equal(h.puts.length, 0);
		assert.equal(intent.originEntryId, undefined);
		const carrier = goalIntentMail(intent).messages[0];
		assert.ok(carrier);
		const nativeId = h.manager.appendCustomMessageEntry(
			carrier.customType,
			carrier.content,
			carrier.display,
			carrier.details,
		);
		await h.mailbox.restore(h.ctx);
		assert.equal(intent.originEntryId, nativeId);
		assert.equal(h.puts.length, 1);
		assert.equal((await h.snapshot()).pending.length, 1);
		assert.equal(
			h.manager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === carrier.customType,
				).length,
			1,
		);
	} finally {
		await h.cleanup();
	}
});
