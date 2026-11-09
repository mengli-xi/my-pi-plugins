import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ActivityTracker,
  stripLatestActivityHeadline,
} from "../src/working-activity.ts";

test("a complete bold headline becomes the activity", () => {
  const tracker = new ActivityTracker();
  const changed = tracker.handle({
    type: "thinking_delta",
    delta: "**Explaining quicksort average complexity**\n\nThe user wants",
  });
  assert.equal(changed, true);
  assert.equal(tracker.current(), "Explaining quicksort average complexity");
});

test("a headline split across deltas lands once it closes", () => {
  const tracker = new ActivityTracker();
  assert.equal(tracker.handle({ type: "thinking_delta", delta: "**Scanning the con" }), false);
  assert.equal(tracker.current(), undefined);
  assert.equal(tracker.handle({ type: "thinking_delta", delta: "fig files**\nThen" }), true);
  assert.equal(tracker.current(), "Scanning the config files");
});

test("the newest headline in a block wins", () => {
  const tracker = new ActivityTracker();
  tracker.handle({
    type: "thinking_delta",
    delta: "**Reading the schema**\ntext\n**Patching the handler**\nmore",
  });
  assert.equal(tracker.current(), "Patching the handler");
});

test("an unchanged headline does not report a change", () => {
  const tracker = new ActivityTracker();
  assert.equal(tracker.handle({ type: "thinking_delta", delta: "**Same**\n" }), true);
  assert.equal(tracker.handle({ type: "thinking_delta", delta: "trailing prose" }), false);
});

test("a new thinking block keeps the last headline until replaced", () => {
  const tracker = new ActivityTracker();
  tracker.handle({ type: "thinking_delta", delta: "**First step**\n" });
  tracker.handle({ type: "thinking_start" });
  assert.equal(tracker.current(), "First step");
  tracker.handle({ type: "thinking_delta", delta: "**Second step**\n" });
  assert.equal(tracker.current(), "Second step");
});

test("free-text thinking never produces a headline", () => {
  const tracker = new ActivityTracker();
  const changed = tracker.handle({
    type: "thinking_delta",
    delta: "Let me look at the config loader first, since the bug\nreproduces there.",
  });
  assert.equal(changed, false);
  assert.equal(tracker.current(), undefined);
});

test("inline bold prose remains thinking instead of becoming an activity", () => {
  const tracker = new ActivityTracker();
  assert.equal(
    tracker.handle({
      type: "thinking_delta",
      delta: "This is **important context** inside a sentence.",
    }),
    false,
  );
  assert.equal(tracker.current(), undefined);
});

test("text deltas and other events are ignored", () => {
  const tracker = new ActivityTracker();
  assert.equal(tracker.handle({ type: "text_delta", delta: "**not a headline**" }), false);
  assert.equal(tracker.handle({ type: "toolcall_delta", delta: "{}" }), false);
  assert.equal(tracker.current(), undefined);
});

test("overlong headlines are cut to one row's worth", () => {
  const tracker = new ActivityTracker();
  tracker.handle({ type: "thinking_delta", delta: `**${"x".repeat(120)}**` });
  assert.equal(tracker.current()!.length, 56);
  assert.ok(tracker.current()!.endsWith("…"));
});

test("the spinner-owned headline can be removed without losing its body", () => {
  assert.deepEqual(
    stripLatestActivityHeadline(
      "**Inspecting the renderer**\n\nKeep this reasoning body.",
    ),
    {
      thinking: "Keep this reasoning body.",
      headline: {
        label: "Inspecting the renderer",
        start: 0,
        end: 27,
      },
    },
  );
});

test("only the newest spinner-owned headline is removed", () => {
  assert.equal(
    stripLatestActivityHeadline(
      "**First pass**\n\nEarlier detail.\n\n**Second pass**\n\nCurrent detail.",
    ).thinking,
    "**First pass**\n\nEarlier detail.\n\nCurrent detail.",
  );
});

test("reset clears both headline and buffer", () => {
  const tracker = new ActivityTracker();
  tracker.handle({ type: "thinking_delta", delta: "**Old run**\n and **half" });
  tracker.reset();
  assert.equal(tracker.current(), undefined);
  // The dangling half-headline from before the reset cannot complete.
  assert.equal(tracker.handle({ type: "thinking_delta", delta: " open**" }), false);
});
