import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ViewInitialization } from "../src/view-initialization.ts";

test("one overall deadline reveals the view without completing or repeating initialization", async () => {
  let expired = 0;
  const scope = new ViewInitialization(20, () => expired++);
  await delay(50);
  assert.equal(expired, 1);
  assert.equal(scope.finished, false);
  assert.equal(scope.abort.signal.aborted, false);
  scope.complete();
  await delay(30);
  assert.equal(expired, 1);
});

for (const phase of ["native init", "extension rebind", "onLoaded"]) {
  test(`cancellation abandons a pending ${phase} and fences its late completion`, async () => {
    let release!: () => void, continued = false, expired = 0;
    const scope = new ViewInitialization(20, () => expired++);
    const waiting = (async () => {
      await scope.wait(new Promise<void>(resolve => { release = resolve; }));
      continued = true;
    })();
    scope.cancel();
    await assert.rejects(waiting, /abandoned/);
    release();
    await delay(40);
    assert.equal(continued, false);
    assert.equal(expired, 0);
  });
}

test("normal readiness cancels the deadline", async () => {
  let expired = 0;
  const scope = new ViewInitialization(20, () => expired++);
  await scope.wait(Promise.resolve());
  scope.complete();
  await delay(40);
  assert.equal(expired, 0);
});

test("an operation that requests close synchronously still has its later rejection observed", async () => {
  const scope = new ViewInitialization(20, () => assert.fail("cancelled deadline"));
  scope.cancel();
  await assert.rejects(scope.wait(Promise.reject(new Error("late failure"))), /abandoned/);
  await delay(0);
});
