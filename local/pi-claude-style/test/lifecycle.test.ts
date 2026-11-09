import assert from "node:assert/strict";
import test from "node:test";
import { DisposableStack, LifecycleManager, type Feature } from "../src/lifecycle.ts";

function feature(id: string, events: string[], options: { installError?: boolean; disposeError?: boolean } = {}): Feature {
	return {
		id,
		install: () => {
			if (options.installError) throw new Error(`${id} install`);
			events.push(`install:${id}`);
			return { dispose: () => {
				events.push(`dispose:${id}`);
				if (options.disposeError) throw new Error(`${id} dispose`);
			} };
		},
		health: () => ({ status: "ok" }),
	};
}

test("a feature has at most one active instance and teardown is reverse-order", async () => {
	const events: string[] = [];
	const manager = new LifecycleManager();
	assert.equal(manager.install(feature("a", events), undefined), true);
	assert.equal(manager.install(feature("a", events), undefined), false);
	manager.install(feature("b", events), undefined);
	await manager.teardownAll();
	assert.deepEqual(events, ["install:a", "install:b", "dispose:b", "dispose:a"]);
});

test("one optional feature failure does not prevent the next feature", async () => {
	const events: string[] = [];
	const manager = new LifecycleManager();
	assert.equal(manager.install(feature("bad", events, { installError: true }), undefined), false);
	assert.equal(manager.install(feature("good", events), undefined), true);
	assert.match(manager.health().bad?.detail ?? "", /bad install/);
	await manager.teardownAll();
});

test("restart-only changes are recorded as pending instead of half-applied", () => {
	const manager = new LifecycleManager();
	manager.install(feature("static", []), undefined);
	assert.deepEqual(manager.apply("static", { on: false }, { on: true }), {
		kind: "pending",
		apply: "restart",
	});
});

test("a disposable stack releases every resource in reverse order and only once", async () => {
	const events: string[] = [];
	const stack = new DisposableStack();
	stack.defer(() => { events.push("first"); });
	stack.defer(() => { events.push("second"); });
	await stack.dispose();
	await stack.dispose();
	assert.deepEqual(events, ["second", "first"]);
});

test("one resource failure does not prevent the rest of a stack from disposing", async () => {
	const events: string[] = [];
	const stack = new DisposableStack();
	stack.defer(() => { events.push("before"); });
	stack.defer(() => { throw new Error("dispose failed"); });
	stack.defer(() => { events.push("after"); });
	await assert.rejects(() => stack.dispose(), /dispose failed/);
	assert.deepEqual(events, ["after", "before"]);
});

test("teardown closes the manager and immediately disposes late installations", async () => {
	const events: string[] = [];
	const manager = new LifecycleManager();
	manager.install(feature("early", events), undefined);
	await manager.teardownAll();

	assert.equal(manager.isClosed, true);
	assert.equal(manager.install(feature("late", events), undefined), false);
	assert.deepEqual(manager.activeIds, []);
	assert.deepEqual(events, ["install:early", "dispose:early", "install:late", "dispose:late"]);
});

test("a resource registered after disposal is cleaned without an unhandled rejection", async () => {
	const stack = new DisposableStack();
	await stack.dispose();

	let disposed = 0;
	stack.defer(async () => {
		disposed++;
		throw new Error("late async failure");
	});
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(disposed, 1);
});
