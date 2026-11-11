import assert from "node:assert/strict";
import test from "node:test";
import { OccupancyRegistry } from "../src/occupancy.ts";

test("legacy persisted holder remains occupied but is not injection eligible", () => {
  const snapshots: unknown[] = [];
  const registry = new OccupancyRegistry({
    alive: () => true,
    initial: [{ sessionId: "s", pid: 10 }],
    onChange: (entries) => snapshots.push(entries),
  });

  assert.equal(registry.isOccupied("s"), true);
  assert.equal(registry.getUniqueHolder("s"), undefined);
  assert.deepEqual(registry.snapshot(), [{ sessionId: "s", pid: 10 }]);
  assert.deepEqual(snapshots, []);
});

test("register upgrades a legacy holder and only a higher generation replaces it", () => {
  const snapshots: unknown[] = [];
  const registry = new OccupancyRegistry({
    alive: () => true,
    initial: [{ sessionId: "s", pid: 10 }],
    onChange: (entries) => snapshots.push(entries),
  });

  registry.register("s", 10, "token-a", 1);
  assert.deepEqual(registry.getUniqueHolder("s"), {
    sessionId: "s",
    pid: 10,
    holderToken: "token-a",
    bindingGen: 1,
  });
  registry.register("s", 10, "token-b", 2);
  assert.deepEqual(registry.snapshot(), [
    { sessionId: "s", pid: 10, holderToken: "token-b", bindingGen: 2 },
  ]);
  assert.equal(snapshots.length, 2);
});

test("late register from an older or equal conflicting generation cannot replace the current binding", () => {
  const registry = new OccupancyRegistry(() => true);
  registry.register("s", 11, "old", 1);
  registry.register("s", 11, "new", 2);
  assert.deepEqual(registry.register("s", 11, "old", 1), { accepted: false, currentGeneration: 2 });
  assert.deepEqual(registry.register("s", 11, "same-generation-other-token", 2), { accepted: false, currentGeneration: 2 });
  assert.deepEqual(registry.getUniqueHolder("s"), {
    sessionId: "s", pid: 11, holderToken: "new", bindingGen: 2,
  });
  registry.unregister("s", 11, "old", 1);
  assert.equal(registry.isOccupied("s"), true, "late old shutdown must not clear the new binding");
});

test("tokenful unregister requires an exact token while legacy unregister is pid-only", () => {
  const registry = new OccupancyRegistry({ alive: () => true });
  registry.register("tokenful", 10, "current");
  registry.unregister("tokenful", 10, "stale");
  assert.equal(registry.isOccupied("tokenful"), true);
  registry.unregister("tokenful", 10);
  assert.equal(registry.isOccupied("tokenful"), true);
  registry.unregister("tokenful", 10, "current");
  assert.equal(registry.isOccupied("tokenful"), false);

  registry.register("legacy", 11);
  registry.unregister("legacy", 11, "ignored-for-legacy");
  assert.equal(registry.isOccupied("legacy"), false);
});

test("multiple live holders fail closed for injection", () => {
  const registry = new OccupancyRegistry({ alive: () => true });
  registry.register("s", 10, "token-a");
  registry.register("s", 11, "token-b");

  assert.equal(registry.isOccupied("s"), true);
  assert.equal(registry.getUniqueHolder("s"), undefined);
});

test("liveness pruning updates persistence and can reveal a unique holder", () => {
  const live = new Set([10, 11]);
  const snapshots: Array<ReturnType<OccupancyRegistry["snapshot"]>> = [];
  const registry = new OccupancyRegistry({
    alive: (pid) => live.has(pid),
    onChange: (entries) => snapshots.push(entries),
  });
  registry.register("s", 10, "token-a");
  registry.register("s", 11, "token-b");
  live.delete(11);

  assert.deepEqual(registry.getUniqueHolder("s"), {
    sessionId: "s",
    pid: 10,
    holderToken: "token-a",
    bindingGen: 0,
  });
  assert.deepEqual(snapshots.at(-1), [
    { sessionId: "s", pid: 10, holderToken: "token-a", bindingGen: 0 },
  ]);
});

test("constructor persists removal of dead restored holders", () => {
  const snapshots: unknown[] = [];
  new OccupancyRegistry({
    alive: (pid) => pid === 10,
    initial: [
      { sessionId: "live", pid: 10, holderToken: "token-a" },
      { sessionId: "dead", pid: 11, holderToken: "token-b" },
    ],
    onChange: (entries) => snapshots.push(entries),
  });

  assert.deepEqual(snapshots, [[
    { sessionId: "live", pid: 10, holderToken: "token-a", bindingGen: 0 },
  ]]);
});
