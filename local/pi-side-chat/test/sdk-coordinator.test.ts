import assert from "node:assert/strict";
import test from "node:test";
import { SdkSideCoordinator } from "../sdk-coordinator.ts";

test("SDK coordinator rejects noninteractive entry before requesting a context", async () => {
  let selections = 0;
  const owner = new SdkSideCoordinator({} as never, { select() { selections++; } } as never);
  await assert.rejects(owner.toggle({ hasUI: false } as never), /interactive Main terminal/);
  assert.equal(selections, 0);
  assert.equal(owner.side, undefined);
  await owner.shutdown("quit");
});

test("shutdown cancels pending native-context acceptance without resurrecting Side", async () => {
  let confirmStarted!: () => void;
  const started = new Promise<void>(resolve => { confirmStarted = resolve; });
  const owner = new SdkSideCoordinator({} as never, { select() { throw new Error("No effective capture"); } } as never);
  const ctx = { model: {}, hasUI: true, ui: { custom() { confirmStarted(); return new Promise(() => {}); } } };
  const opening = owner.open(ctx as never);
  const rejection = assert.rejects(opening, /Side opening cancelled/);
  await started;
  assert.ok(owner.mainTerminalOccupied());
  await owner.shutdown("quit");
  await rejection;
  assert.equal(owner.side, undefined);
  assert.equal(owner.mainTerminalOccupied(), undefined);
  assert.equal(await owner.destroy(), false);
});
