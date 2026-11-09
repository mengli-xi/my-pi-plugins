import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_GOAL } from "../src/config.ts";
import {
  buildGoalLine,
  cumulativeAssistantTokens,
  formatGoalRuntime,
  formatGoalTokens,
  readGoalSnapshot,
  readGoalSnapshotV1,
} from "../src/goal-status.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

const NOW = 1_000_000;

function stateEntry(goal: unknown, queue: unknown[] = []) {
  return {
    type: "custom",
    customType: "goal-state",
    data: queue.length ? { goal, queue } : { goal },
  };
}

function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    text: "make the spinner stop jumping",
    status: "active",
    startedAt: NOW - 800_000,
    updatedAt: NOW,
    iteration: 3,
    tokensUsed: 1_000,
    timeUsedSeconds: 600,
    baselineTokens: 0,
    automaticModelTurns: 2,
    toolFreeRepeatCount: 0,
    ...overrides,
  };
}

test("reads the newest goal-state entry and ignores other entries", () => {
  const entries = [
    { type: "message" },
    stateEntry(goal({ text: "old goal", timeUsedSeconds: 10 })),
    { type: "custom", customType: "plan-mode-state", data: { enabled: true } },
    stateEntry(goal({ text: "current goal" })),
  ];
  const snapshot = readGoalSnapshot(entries, NOW);
  assert.equal(snapshot?.text, "current goal");
  assert.equal(snapshot?.phase, "active");
});

test("validates the versioned goal snapshot and its session", () => {
  const payload = {
    version: 1,
    sessionId: "s1",
    goal: {
      id: "goal-1",
      text: " semantic goal ",
      phase: "active",
      runtimeSeconds: 12,
      tokensUsed: 345,
      tokenBudget: 1_000,
      queued: 2,
      observedAt: NOW,
    },
  };
  assert.deepEqual(readGoalSnapshotV1(payload, "s1"), {
    id: "goal-1",
    text: "semantic goal",
    phase: "active",
    runtimeSeconds: 12,
    tokensUsed: 345,
    tokenBudget: 1_000,
    queued: 2,
    observedAt: NOW,
  });
  assert.equal(readGoalSnapshotV1({ ...payload, version: 2 }, "s1"), undefined);
  assert.equal(readGoalSnapshotV1({ ...payload, sessionId: "other" }, "s1"), undefined);
  assert.equal(readGoalSnapshotV1({ version: 1, goal: payload.goal }, "s1"), undefined);
  assert.equal(readGoalSnapshotV1({ ...payload, goal: { ...payload.goal, queued: 1.5 } }, "s1"), undefined);
  assert.equal(readGoalSnapshotV1({ ...payload, goal: null }, "s1"), null);
});

test("adds the in-flight stretch to the settled runtime", () => {
  // pi-goal settles elapsed time into timeUsedSeconds and leaves
  // activeStartedAt set while the goal runs.
  const running = readGoalSnapshot(
    [stateEntry(goal({ timeUsedSeconds: 600, activeStartedAt: NOW - 54_000 }))],
    NOW,
  );
  assert.equal(running?.runtimeSeconds, 654);

  const paused = readGoalSnapshot(
    [stateEntry(goal({ status: "paused", timeUsedSeconds: 600 }))],
    NOW,
  );
  assert.equal(paused?.runtimeSeconds, 600);
});

test("returns nothing when there is no goal", () => {
  assert.equal(readGoalSnapshot([], NOW), undefined);
  assert.equal(readGoalSnapshot([stateEntry(null)], NOW), undefined);
  assert.equal(
    readGoalSnapshot([stateEntry(goal({ status: "bogus" }))], NOW),
    undefined,
  );
});

test("reports elapsed run time whatever the goal is doing", () => {
  // The status word is its own column now, so this one is always a duration.
  const runtime = (overrides: Record<string, unknown>) =>
    formatGoalRuntime(readGoalSnapshot([stateEntry(goal(overrides))], NOW)!);

  assert.equal(
    runtime({ timeUsedSeconds: 754, activeStartedAt: NOW - 1_000 }),
    "12m35s",
  );
  for (const status of ["paused", "complete", "queued", "blocked", "usage_limited", "budget_limited"]) {
    assert.equal(runtime({ status, timeUsedSeconds: 754 }), "12m34s", status);
  }
});

/** The objective is off by default now; these cover the row that shows it. */
const WITH_TEXT = { ...DEFAULT_GOAL, showText: true };

test("shows only status, runtime and tokens by default", () => {
  const snapshot = readGoalSnapshot([stateEntry(goal({ timeUsedSeconds: 754 }))], NOW)!;
  assert.equal(
    buildGoalLine(snapshot, DEFAULT_GOAL, plainTheme, 80),
    "Goal active 12m34s 1.0k",
  );
});

test("renders status, runtime, tokens, then the objective, left-aligned", () => {
  const snapshot = readGoalSnapshot(
    [
      stateEntry(goal({ timeUsedSeconds: 754 }), [goal({ id: "g2" }), goal({ id: "g3" })]),
    ],
    NOW,
  )!;
  assert.equal(
    buildGoalLine(snapshot, WITH_TEXT, plainTheme, 80),
    "Goal active +2 12m34s 1.0k: make the spinner stop jumping",
  );
});

test("keeps the objective whole until the terminal runs out of room", () => {
  const snapshot = readGoalSnapshot([stateEntry(goal({ timeUsedSeconds: 754 }))], NOW)!;
  // No character cap: the objective uses whatever width is left...
  assert.equal(
    buildGoalLine(snapshot, WITH_TEXT, plainTheme, 90),
    "Goal active 12m34s 1.0k: make the spinner stop jumping",
  );
  // ...and is clipped only by the row it has to fit on.
  const narrow = buildGoalLine(snapshot, WITH_TEXT, plainTheme, 30);
  assert.equal(visibleWidth(narrow), 30);
  assert.ok(narrow.startsWith("Goal active 12m34s 1.0k: make"), narrow);
});

test("never renders more than one row", () => {
  const wide = readGoalSnapshot(
    [stateEntry(goal({ text: "first line\nsecond line", timeUsedSeconds: 754 }))],
    NOW,
  )!;
  const line = buildGoalLine(wide, WITH_TEXT, plainTheme, 80);
  assert.ok(!line.includes("\n"));
  assert.equal(line, "Goal active 12m34s 1.0k: first line second line");
  const cjk = readGoalSnapshot([stateEntry(goal({ text: "把布局按时间尺度重新分组并验证截断" }))], NOW)!;
  assert.ok(visibleWidth(buildGoalLine(cjk, WITH_TEXT, plainTheme, 40)) <= 40);
});

import { GoalStatusController } from "../src/goal-status.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface FakeUi {
  widgets: Map<string, unknown>;
  statuses: Map<string, string | undefined>;
  failWidget: boolean;
}

function fakeContext(entries: unknown[], ui: FakeUi, sessionId?: string): ExtensionContext {
  return {
    hasUI: true,
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => sessionId,
    },
    ui: {
      theme: plainTheme,
      setWidget(key: string, content: unknown) {
        if (ui.failWidget) throw new Error("no room");
        if (content === undefined) ui.widgets.delete(key);
        else ui.widgets.set(key, content);
      },
      setStatus(key: string, text: string | undefined) {
        if (text === undefined) ui.statuses.delete(key);
        else ui.statuses.set(key, text);
      },
    },
  } as unknown as ExtensionContext;
}

function newUi(failWidget = false): FakeUi {
  return { widgets: new Map(), statuses: new Map(), failWidget };
}

function fakeEventBus() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    events: {
      emit(channel: string, payload: unknown) {
        for (const handler of handlers.get(channel) ?? []) handler(payload);
      },
      on(channel: string, handler: (payload: unknown) => void) {
        const list = handlers.get(channel) ?? [];
        list.push(handler);
        handlers.set(channel, list);
        return () => {
          const index = list.indexOf(handler);
          if (index >= 0) list.splice(index, 1);
        };
      },
    },
  };
}

function semanticGoalPayload(goalValue: object | null) {
  return { version: 1, sessionId: "s1", goal: goalValue };
}

const SEMANTIC_GOAL = {
  id: "semantic-1",
  text: "owner-provided state",
  phase: "paused",
  runtimeSeconds: 42,
  tokensUsed: 9_876,
  queued: 3,
  observedAt: NOW,
};

/** Drives one refresh without waiting on the interval. */
function tick(controller: GoalStatusController, ctx: ExtensionContext) {
  (controller as unknown as { refresh(c: ExtensionContext): void }).refresh(ctx);
}

test("places the goal row above the editor", () => {
  const ui = newUi();
  const controller = new GoalStatusController(DEFAULT_GOAL);
  tick(controller, fakeContext([stateEntry(goal())], ui));
  assert.ok(ui.widgets.has("pi-claude-transcript:goal"));
  assert.equal(ui.statuses.size, 0);
});

test("owner-first request/reply wins over transcript internals", () => {
  const bus = fakeEventBus();
  bus.events.on("goal:request:snapshot-v1", (value) => {
    const request = value as { reply?: (payload: unknown) => void };
    request.reply?.(semanticGoalPayload(SEMANTIC_GOAL));
  });
  const ui = newUi();
  const controller = new GoalStatusController(DEFAULT_GOAL, bus.events);
  controller.start(fakeContext([stateEntry(goal({ text: "legacy", tokensUsed: 1 }))], ui, "s1"));
  const state = controller as unknown as { snapshot?: { id: string; tokensUsed: number } };
  assert.deepEqual(state.snapshot, { ...SEMANTIC_GOAL, tokenBudget: undefined });
  controller.dispose();
});

test("owner clock state alone controls local elapsed time between snapshots", () => {
  for (const clockRunning of [undefined, false, true]) {
    const snapshot = readGoalSnapshotV1(semanticGoalPayload({
      ...SEMANTIC_GOAL, phase: "active", ...(clockRunning === undefined ? {} : { clockRunning }),
    }), "s1")!;
    assert.ok(snapshot);
    const controller = new GoalStatusController(DEFAULT_GOAL);
    const state = controller as unknown as {
      ownerSnapshot: typeof snapshot;
      liveOwnerSnapshot(now: number): typeof snapshot;
    };
    state.ownerSnapshot = snapshot;
    assert.equal(state.liveOwnerSnapshot(NOW + 10_000)?.runtimeSeconds, clockRunning === true ? 52 : 42);
    assert.equal(state.liveOwnerSnapshot(NOW - 10_000)?.runtimeSeconds, 42);
  }
  for (const clockRunning of [0, "true", null]) {
    assert.equal(readGoalSnapshotV1(semanticGoalPayload({ ...SEMANTIC_GOAL, clockRunning }), "s1"), undefined);
  }
});

test("only an explicit owner queue freeze shows queue off while the owner clock stays frozen", () => {
  const bus = fakeEventBus();
  const ui = newUi();
  const controller = new GoalStatusController(DEFAULT_GOAL, bus.events);
  controller.start(fakeContext([], ui, "s1"));
  const state = controller as unknown as {
    lastKey: string;
    liveOwnerSnapshot(now: number): NonNullable<ReturnType<typeof readGoalSnapshotV1>>;
  };
  const pausedClock = { ...SEMANTIC_GOAL, phase: "active", clockRunning: false };
  try {
    bus.events.emit("goal:snapshot-v1", semanticGoalPayload({ ...pausedClock, queueFrozen: true }));
    const frozen = state.liveOwnerSnapshot(NOW + 10_000);
    assert.equal(frozen.runtimeSeconds, 42);
    assert.equal(buildGoalLine(frozen, DEFAULT_GOAL, plainTheme, 80), "Goal active +3 · queue off 42s 9.8k");
    const frozenKey = state.lastKey;
    for (const queueFrozen of [false, undefined]) {
      bus.events.emit("goal:snapshot-v1", semanticGoalPayload({ ...pausedClock, queueFrozen }));
      const snapshot = state.liveOwnerSnapshot(NOW + 10_000);
      assert.equal(snapshot.runtimeSeconds, 42);
      assert.doesNotMatch(buildGoalLine(snapshot, DEFAULT_GOAL, plainTheme, 80), /queue off/);
      assert.notEqual(state.lastKey, frozenKey, "queue freeze changes must republish even when other facts stay unchanged");
    }
    for (const queueFrozen of [0, "true", null]) {
      assert.equal(readGoalSnapshotV1(semanticGoalPayload({ ...pausedClock, queueFrozen }), "s1"), undefined);
    }
  } finally { controller.dispose(); }
});

test("consumer-first broadcast updates once the owner starts", () => {
  const bus = fakeEventBus();
  const ui = newUi();
  const controller = new GoalStatusController(DEFAULT_GOAL, bus.events);
  controller.start(fakeContext([], ui, "s1"));
  assert.equal(ui.widgets.size, 0);

  bus.events.emit("goal:snapshot-v1", semanticGoalPayload(SEMANTIC_GOAL));
  const state = controller as unknown as { snapshot?: { id: string } };
  assert.equal(state.snapshot?.id, "semantic-1");
  assert.ok(ui.widgets.has("pi-claude-transcript:goal"));
  controller.dispose();
});

test("an authoritative empty owner snapshot does not resurrect legacy state", () => {
  const bus = fakeEventBus();
  bus.events.on("goal:request:snapshot-v1", (value) => {
    const request = value as { reply?: (payload: unknown) => void };
    request.reply?.(semanticGoalPayload(null));
  });
  const ui = newUi();
  const controller = new GoalStatusController(DEFAULT_GOAL, bus.events);
  controller.start(fakeContext([stateEntry(goal())], ui, "s1"));
  assert.equal(ui.widgets.size, 0);
  controller.dispose();
});

test("falls back to a status line when no widget can be placed", () => {
  const ui = newUi(true);
  const controller = new GoalStatusController(DEFAULT_GOAL);
  tick(controller, fakeContext([stateEntry(goal({ status: "paused" }))], ui));
  assert.equal(ui.widgets.size, 0);
  assert.equal(
    ui.statuses.get("pi-claude-transcript:goal"),
    "Goal paused 10m00s 1.0k",
  );
});

test("clears the row once the goal is gone", () => {
  const ui = newUi();
  const controller = new GoalStatusController(DEFAULT_GOAL);
  tick(controller, fakeContext([stateEntry(goal())], ui));
  assert.equal(ui.widgets.size, 1);
  tick(controller, fakeContext([stateEntry(null)], ui));
  assert.equal(ui.widgets.size, 0);
});

test("keeps showing Done after pi-goal clears a completed goal", () => {
  const ui = newUi();
  const controller = new GoalStatusController({
    ...DEFAULT_GOAL,
    completedLingerMs: 60_000,
  });
  tick(controller, fakeContext([stateEntry(goal({ status: "complete" }))], ui));
  const done = controller as unknown as { snapshot?: { phase: string } };
  assert.equal(done.snapshot?.phase, "complete");

  // pi-goal appends a cleared entry moments later; the row must not vanish yet.
  tick(controller, fakeContext([stateEntry(null)], ui));
  assert.equal(done.snapshot?.phase, "complete");
  assert.equal(ui.widgets.size, 1);
});

test("equal-length tree branches invalidate the token cache by leaf identity", () => {
  const ui = newUi();
  const controller = new GoalStatusController(DEFAULT_GOAL);
  const branch = (leaf: string, tokens: number) => [
    { id: `message-${leaf}`, ...assistantMessage(tokens) },
    { id: leaf, ...stateEntry(goal({ tokensUsed: 0, baselineTokens: 0 })) },
  ];

  tick(controller, fakeContext(branch("leaf-a", 100), ui));
  const state = controller as unknown as { snapshot?: { tokensUsed: number } };
  assert.equal(state.snapshot?.tokensUsed, 100);

  tick(controller, fakeContext(branch("leaf-b", 250), ui));
  assert.equal(state.snapshot?.tokensUsed, 250);
});

function assistantMessage(totalTokens: number) {
  return { type: "message", message: { role: "assistant", usage: { totalTokens } } };
}

test("sums assistant usage across the branch", () => {
  assert.equal(
    cumulativeAssistantTokens([
      assistantMessage(100),
      { type: "message", message: { role: "user", usage: { totalTokens: 999 } } },
      { type: "custom", customType: "goal-state", data: {} },
      assistantMessage(250),
    ]),
    350,
  );
  // Providers that report no total still bill cache traffic.
  assert.equal(
    cumulativeAssistantTokens([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
        },
      },
    ]),
    135,
  );
});

test("counts tokens billed since pi-goal last checkpointed", () => {
  const entries = [
    assistantMessage(4_000), // before the goal started
    stateEntry(goal({ baselineTokens: 4_000, tokensUsed: 6_000 })),
    assistantMessage(6_000),
    assistantMessage(2_500), // billed after the checkpoint
  ];
  const snapshot = readGoalSnapshot(entries, NOW)!;
  assert.equal(snapshot.tokensUsed, 8_500);
});

test("freezes the token total once the goal stops", () => {
  const entries = [
    stateEntry(goal({ status: "paused", baselineTokens: 0, tokensUsed: 6_000 })),
    assistantMessage(9_999), // billed to whatever ran after the goal paused
  ];
  assert.equal(readGoalSnapshot(entries, NOW)!.tokensUsed, 6_000);
});

test("never reports fewer tokens than the last checkpoint", () => {
  // Compaction can shorten the branch, so the derived total can fall behind.
  const entries = [
    stateEntry(goal({ baselineTokens: 0, tokensUsed: 50_000 })),
    assistantMessage(1_000),
  ];
  assert.equal(readGoalSnapshot(entries, NOW)!.tokensUsed, 50_000);
});

test("shows the budget alongside the total when the goal has one", () => {
  const withBudget = readGoalSnapshot(
    [stateEntry(goal({ tokensUsed: 12_400, tokenBudget: 50_000, baselineTokens: 0 }))],
    NOW,
  )!;
  assert.equal(formatGoalTokens(withBudget), "12.4k/50.0k");
  assert.equal(
    buildGoalLine(withBudget, { ...DEFAULT_GOAL, showText: false }, plainTheme, 80).trimStart(),
    "Goal active 10m00s 12.4k/50.0k",
  );

  const noBudget = readGoalSnapshot(
    [stateEntry(goal({ tokensUsed: 12_400, baselineTokens: 0 }))],
    NOW,
  )!;
  assert.equal(formatGoalTokens(noBudget), "12.4k");
});

test("showTokens turns the token column off", () => {
  const off = readGoalSnapshot([stateEntry(goal({ tokensUsed: 900 }))], NOW)!;
  assert.equal(
    buildGoalLine(
      off,
      { ...DEFAULT_GOAL, showText: false, showTokens: false },
      plainTheme,
      80,
    ).trimStart(),
    "Goal active 10m00s",
  );
});

/** A stand-in for `pi-statusline` listening on the shared bus. */
function fakeStatusline(accept = true) {
  const rows: Array<{ key: string; line?: string; placement?: string; row?: number; align?: string }> = [];
  return {
    rows,
    events: {
      emit(channel: string, payload: unknown) {
        if (channel !== "statusline:row") return;
        const row = payload as {
          key: string; line?: string; placement?: string; row?: number;
          align?: string; reply?: (v: true) => void;
        };
        rows.push({ key: row.key, line: row.line, placement: row.placement, row: row.row, align: row.align });
        if (accept) row.reply?.(true);
      },
    },
  };
}

const ON_STATUSLINE = { ...DEFAULT_GOAL, placement: "statusline" as const };

test("hands the row to the statusline, right-aligned and without a widget", () => {
  const ui = newUi();
  const statusline = fakeStatusline();
  const controller = new GoalStatusController(ON_STATUSLINE, statusline.events);

  tick(controller, fakeContext([stateEntry(goal({ status: "paused" }))], ui));

  assert.deepEqual(statusline.rows, [
    {
      key: "goal",
      line: "Goal paused 10m00s 1.0k",
      placement: "inline",
      row: 3,
      align: "right",
    },
  ]);
  // Right side of the statusline's third row; the row carries no padding of
  // its own because only that renderer knows the width.
  assert.equal(ui.widgets.size, 0, "no widget of its own");
  assert.equal(ui.statuses.size, 0);
});

test("withdraws the row when the goal is gone", () => {
  const ui = newUi();
  const statusline = fakeStatusline();
  const controller = new GoalStatusController(ON_STATUSLINE, statusline.events);

  tick(controller, fakeContext([stateEntry(goal())], ui));
  tick(controller, fakeContext([stateEntry(null)], ui));

  assert.equal(statusline.rows.length, 2);
  assert.deepEqual(statusline.rows[1], {
    key: "goal",
    line: undefined,
    placement: undefined,
    row: undefined,
    align: undefined,
  });
});

test("falls back to its own widget when no statusline answers", () => {
  const ui = newUi();
  const statusline = fakeStatusline(false);
  const controller = new GoalStatusController(ON_STATUSLINE, statusline.events);

  tick(controller, fakeContext([stateEntry(goal())], ui));

  assert.equal(statusline.rows.length, 1, "it did offer the row");
  assert.ok(ui.widgets.has("pi-claude-transcript:goal"), "and drew it itself");
});

test("with no event bus at all it behaves like a plain widget", () => {
  const ui = newUi();
  const controller = new GoalStatusController(ON_STATUSLINE);
  tick(controller, fakeContext([stateEntry(goal())], ui));
  assert.ok(ui.widgets.has("pi-claude-transcript:goal"));
});
