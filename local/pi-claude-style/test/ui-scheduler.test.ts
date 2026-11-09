import assert from "node:assert/strict";
import test from "node:test";
import {
  UiScheduler,
  type SchedulerNativeClock,
} from "../src/ui-scheduler.ts";

class FakeClock implements SchedulerNativeClock {
  current = 0;
  nextId = 1;
  timers = new Map<number, { dueAt: number; callback: () => void }>();

  now(): number { return this.current; }

  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    const end = this.current + ms;
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.dueAt <= end)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.current = next[1].dueAt;
      next[1].callback();
    }
    this.current = end;
  }
}

test("nearby visual work shares one native wakeup", () => {
  const clock = new FakeClock();
  const scheduler = new UiScheduler(undefined, clock, 4);
  const calls: string[] = [];
  scheduler.setTimer(() => calls.push("working"), 50);
  scheduler.setTimer(() => calls.push("typewriter"), 53);
  assert.equal(clock.timers.size, 1);
  clock.advance(50);
  assert.deepEqual(calls, ["working", "typewriter"]);
  assert.equal(clock.timers.size, 0);
});

test("cancellation and dispose release queued work", () => {
  const clock = new FakeClock();
  const scheduler = new UiScheduler(undefined, clock);
  let calls = 0;
  const first = scheduler.setTimer(() => calls++, 10);
  scheduler.setTimer(() => calls++, 20);
  scheduler.clearTimer(first);
  clock.advance(15);
  assert.equal(calls, 0);
  scheduler.dispose();
  assert.equal(clock.timers.size, 0);
  clock.advance(100);
  assert.equal(calls, 0);
});
