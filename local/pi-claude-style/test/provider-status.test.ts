import assert from "node:assert/strict";
import test from "node:test";
import {
  providerActiveElapsedMs,
  ProviderStatusTracker,
  formatProviderStatus,
} from "../src/provider-status.ts";
import { RESET_FG, workingStatusPalette } from "../src/cyber-style.ts";

function lifecycle(type: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    provider: "example-provider",
    sessionId: "session-1",
    kind: "lifecycle",
    event: { channel: "lifecycle", type, ...extra },
  };
}

function harness(startedAt = 1_000) {
  let now = startedAt;
  const tracker = new ProviderStatusTracker({ now: () => now });
  tracker.start("example-provider", "session-1");
  return { tracker, at: (timestamp: number) => { now = timestamp; } };
}

test("accumulates queue time across turns and counts overlaps once", () => {
  const { tracker, at } = harness();
  tracker.handle(lifecycle("load.update", {
    source: "local",
    load: { active: 4, queued: 2, backgroundActive: 1, maxActive: 4 },
  }));
  tracker.handle(lifecycle("queue.enter", { source: "local", attempt: 0, position: 2 }));
  at(2_000);
  tracker.handle(lifecycle("queue.enter", { source: "upstream", attempt: 1, position: 7 }));
  at(3_000);
  tracker.handle(lifecycle("queue.leave", { source: "local", attempt: 0 }));
  at(4_000);
  tracker.handle(lifecycle("queue.leave", { source: "upstream", attempt: 1 }));
  tracker.handle({ version: 1, provider: "example-provider", sessionId: "session-1", kind: "turn.end" });
  at(5_000);
  tracker.handle(lifecycle("queue.enter", { source: "local", position: 1 }));
  at(7_000);
  tracker.handle(lifecycle("queue.leave", { source: "local" }));
  assert.equal(tracker.snapshot().queueMs, 5_000);
  assert.equal(formatProviderStatus(tracker.snapshot()), "[G 4/4 · BG 1]");
});

test("uses reported queue duration between events, ahead of queueEnteredAt", () => {
  const { tracker, at } = harness();
  tracker.handle(lifecycle("queue.enter", {
    source: "upstream", attempt: 1, position: 1, queuedMs: 5_760_000, queueEnteredAt: 1_000,
  }));
  assert.equal(formatProviderStatus(tracker.snapshot()), "[Queue #1 1h36m00s]");
  at(3_000);
  assert.equal(tracker.snapshot().queueMs, 5_762_000);
  tracker.handle(lifecycle("queue.update", {
    source: "upstream", attempt: 1, position: 1, queuedMs: 5_765_000,
  }));
  at(4_000);
  assert.equal(tracker.snapshot().queueMs, 5_766_000);
  tracker.handle(lifecycle("queue.enter", { source: "local", attempt: 2, position: 2, queuedMs: 1_000 }));
  assert.equal(tracker.snapshot().queueMs, 5_766_000);
  at(5_000);
  tracker.handle(lifecycle("queue.leave", { source: "local", attempt: 2, queuedMs: 2_000 }));
  at(6_000);
  tracker.handle(lifecycle("queue.leave", { source: "upstream", attempt: 1, queuedMs: 5_767_000 }));
  assert.equal(tracker.snapshot().queueMs, 5_767_000);
  at(7_000);
  assert.equal(tracker.snapshot().queueMs, 5_767_000);
});

test("uses queueEnteredAt without duration and falls back to the local clock", () => {
  const { tracker, at } = harness(7_000);
  tracker.handle(lifecycle("queue.update", { source: "upstream", position: 1, queueEnteredAt: 5_000 }));
  at(8_000);
  assert.equal(tracker.snapshot().queueMs, 3_000);
  tracker.handle(lifecycle("queue.leave", { source: "upstream" }));
  tracker.start("example-provider", "session-1");
  tracker.handle(lifecycle("queue.enter", { source: "upstream", position: 1 }));
  at(10_000);
  tracker.handle(lifecycle("queue.update", { source: "upstream", position: 1 }));
  at(11_000);
  assert.equal(formatProviderStatus(tracker.snapshot()), "[Queue #1 3.0s]");
  tracker.handle(lifecycle("queue.leave", { source: "upstream" }));
  assert.equal(tracker.snapshot().queueMs, 3_000);
});

test("accepts arbitrary providers and fences provider and session identities", () => {
  const { tracker } = harness();
  const entered = lifecycle("queue.enter", { source: "local", position: 2 });
  tracker.handle({ ...entered, provider: "another-provider" });
  tracker.handle({ ...entered, sessionId: "another-session" });
  assert.equal(formatProviderStatus(tracker.snapshot()), "");
  tracker.handle(entered);
  assert.equal(formatProviderStatus(tracker.snapshot()), "[Queue#2 0.0s]");
  tracker.start("another-provider", "session-1");
  assert.equal(tracker.snapshot().queueActive, false);
  tracker.handle({ ...entered, provider: "another-provider" });
  assert.equal(tracker.snapshot().localPosition, 2);
  tracker.start(undefined, "session-1");
  tracker.handle(entered);
  assert.equal(tracker.snapshot().enabled, false);
  tracker.start("example-provider", "");
  assert.equal(tracker.snapshot().enabled, false);
});

test("rejects malformed observations without changing the current status", () => {
  const { tracker } = harness();
  for (const event of [
    lifecycle("queue.enter", { source: "invalid", position: 2 }),
    lifecycle("queue.enter", { position: 2 }),
    lifecycle("queue.enter", { source: "local", queuedMs: -1 }),
    lifecycle("queue.enter", { source: "local", queueEnteredAt: "yesterday" }),
    lifecycle("load.update", { load: { active: 1, queued: 0, backgroundActive: 0, maxActive: 0 } }),
    { ...lifecycle("attempt.start", { attempt: 2 }), version: 2 },
  ]) tracker.handle(event);
  assert.equal(formatProviderStatus(tracker.snapshot()), "");
  assert.equal(tracker.snapshot().queueMs, 0);
});

test("places the current queue explanation before accumulated time", () => {
  const { tracker, at } = harness(0);
  tracker.handle(lifecycle("queue.enter", {
    source: "upstream", attempt: 2, position: 7,
    load: { active: 3, queued: 1, backgroundActive: 0, maxActive: 4 },
  }));
  at(18_700);
  assert.equal(formatProviderStatus(tracker.snapshot()), "[G 3/4 · Queue #7 18.7s]");
  assert.equal(providerActiveElapsedMs(52_800, tracker.snapshot()), 34_100);
  assert.equal(providerActiveElapsedMs(1_000, tracker.snapshot()), 0);
});

test("clears only the queue position that has started executing", () => {
  const { tracker, at } = harness();
  tracker.handle(lifecycle("queue.enter", { source: "local", position: 2 }));
  tracker.handle(lifecycle("queue.enter", { source: "upstream", position: 7 }));
  at(2_000);
  tracker.handle(lifecycle("queue.leave", { source: "local" }));
  assert.equal(formatProviderStatus(tracker.snapshot()), "[Queue #7 1.0s]");
  at(3_000);
  tracker.handle(lifecycle("queue.leave", { source: "upstream" }));
  assert.equal(tracker.snapshot().queueActive, false);
  assert.equal(tracker.snapshot().queueMs, 2_000);
  assert.equal(formatProviderStatus(tracker.snapshot()), "");
});

test("retains queue time after execution begins and closes open queues at turn end", () => {
  const { tracker, at } = harness();
  tracker.handle(lifecycle("attempt.start", { attempt: 3 }));
  tracker.handle(lifecycle("queue.enter", { source: "local", position: 2 }));
  at(2_500);
  tracker.handle({ version: 1, provider: "example-provider", sessionId: "session-1", kind: "turn.end" });
  at(5_000);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.queueMs, 1_500);
  assert.equal(snapshot.retryAttempt, undefined);
  assert.equal(formatProviderStatus(snapshot), "");
  assert.equal(providerActiveElapsedMs(4_000, snapshot), 2_500);
});

test("shows retries and independent load fields without requiring queues", () => {
  const { tracker } = harness();
  tracker.handle(lifecycle("attempt.start", { attempt: 2 }));
  tracker.handle(lifecycle("load.update", { load: { active: 3, queued: 2, backgroundActive: 1 } }));
  assert.equal(formatProviderStatus(tracker.snapshot()), "[G 3 · BG 1 · Retry 2]");
  assert.equal(tracker.snapshot().load?.queued, 2);
  tracker.handle(lifecycle("attempt.start", { attempt: 1 }));
  assert.equal(formatProviderStatus(tracker.snapshot()), "[G 3 · BG 1]");
});

test("leaves elapsed time unchanged without an observation", () => {
  const tracker = new ProviderStatusTracker();
  assert.equal(providerActiveElapsedMs(52_800, tracker.snapshot()), 52_800);
  tracker.start("another-provider", "session-1");
  assert.equal(providerActiveElapsedMs(52_800, tracker.snapshot()), 52_800);
});

test("uses the provider's independent dark value tone without semantic highlights", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
  const value = (text: string) => `${workingStatusPalette.provider}${text}${RESET_FG}`;
  const status = (position: number) => formatProviderStatus({
    enabled: true, queueActive: true, localPosition: 2, upstreamPosition: position, queueMs: 1_000,
  }, theme as never);
  assert.equal(status(7),
    `<muted>[</muted><muted>Queue</muted>${value("#2")}` +
    `<muted> </muted>${value("#7")}<muted> </muted>${value("1.0s")}<muted>]</muted>`);
  assert.equal(status(1).includes("success"), false);
  assert.equal(status(7).includes("warning"), false);
  assert.equal(status(11).includes("error"), false);
});
