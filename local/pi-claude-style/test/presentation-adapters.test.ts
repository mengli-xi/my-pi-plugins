import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultToolPresentationRegistry,
  ToolPresentationRegistry,
  type PresentationInstrumentation,
  type ToolPresentationAdapter,
} from "../src/presentation-adapters.ts";
import type {
  ToolActivity,
  ToolGroupSnapshot,
  ToolPresentation,
} from "../src/types.ts";

function activity(
  toolName: string,
  args: unknown = {},
  id = "call-1",
): ToolActivity {
  return {
    id,
    groupId: "group-1",
    toolName,
    args,
    status: "completed",
    startedAt: 1,
    endedAt: 2,
  };
}

function group(
  activities: ToolActivity[],
  overrides: Partial<ToolGroupSnapshot> = {},
): ToolGroupSnapshot {
  return {
    id: "group-1",
    anchorToolCallId: activities[0]?.id ?? "call-1",
    presentation: "grouped",
    activities,
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    failureCount: 0,
    runningCount: 0,
    ...overrides,
  };
}

function fallbackRegistry(instrumentation?: PresentationInstrumentation) {
  return new ToolPresentationRegistry(
    {
      resolve: () => ({ kind: "grouped" }),
      formatActivity: (item) => `fallback activity ${item.toolName}`,
      summarizeGroup: (item) => `fallback group ${item.activities.length}`,
    },
    instrumentation,
  );
}

test("higher-priority adapters win and unregister invalidates cached choices", () => {
  const registry = fallbackRegistry();
  const args = {};
  const low: ToolPresentationAdapter = {
    id: "low",
    priority: 1,
    match: () => true,
    presentation: () => ({ kind: "native" }),
  };
  const high: ToolPresentationAdapter = {
    id: "high",
    priority: 10,
    match: () => true,
    presentation: () => ({ kind: "question" }),
  };
  registry.register(low);
  const removeHigh = registry.register(high);

  assert.deepEqual(registry.resolve("demo", args), { kind: "question" });
  removeHigh();
  assert.deepEqual(registry.resolve("demo", args), { kind: "native" });
  assert.throws(() => registry.register(low), /duplicate presentation adapter/);
});

test("identity caches avoid repeated matching and report hits and misses", () => {
  const counters = new Map<string, number>();
  const spans: string[] = [];
  const instrumentation: PresentationInstrumentation = {
    measure(name, action) {
      spans.push(name);
      return action();
    },
    increment(name, delta = 1) {
      counters.set(name, (counters.get(name) ?? 0) + delta);
    },
  };
  const registry = fallbackRegistry(instrumentation);
  let resolutions = 0;
  let activities = 0;
  let groups = 0;
  let tones = 0;
  registry.register({
    id: "demo",
    match: () => true,
    presentation: () => {
      resolutions++;
      return { kind: "grouped" };
    },
    formatActivity: () => {
      activities++;
      return "formatted";
    },
    summarizeGroup: () => {
      groups++;
      return "summarized";
    },
    groupTone: () => {
      tones++;
      return "success";
    },
  });

  const args = {};
  const item = activity("demo", args);
  const snapshot = group([item]);
  assert.deepEqual(registry.resolve("demo", args), { kind: "grouped" });
  assert.deepEqual(registry.resolve("demo", args), { kind: "grouped" });
  assert.equal(registry.formatActivity(item), "formatted");
  assert.equal(registry.formatActivity(item), "formatted");
  assert.equal(registry.summarizeGroup(snapshot), "summarized");
  assert.equal(registry.summarizeGroup(snapshot), "summarized");
  assert.equal(registry.groupTone(snapshot), "success");
  assert.equal(registry.groupTone(snapshot), "success");

  assert.deepEqual({ resolutions, activities, groups, tones }, {
    resolutions: 1,
    activities: 1,
    groups: 1,
    tones: 1,
  });
  assert.equal(counters.get("cc-style.presentation.resolve.cache-hit"), 1);
  assert.equal(counters.get("cc-style.presentation.activity.cache-hit"), 1);
  assert.equal(counters.get("cc-style.presentation.group.cache-hit"), 1);
  assert.equal(counters.get("cc-style.presentation.tone.cache-hit"), 1);
  assert.deepEqual(spans.sort(), [
    "cc-style.presentation.activity",
    "cc-style.presentation.group",
    "cc-style.presentation.resolve",
    "cc-style.presentation.tone",
  ]);
});

test("adapter failures fail open to generic presentation", () => {
  const counters = new Map<string, number>();
  const registry = fallbackRegistry({
    measure: (_name, action) => action(),
    increment: (name, delta = 1) =>
      counters.set(name, (counters.get(name) ?? 0) + delta),
  });
  registry.register({
    id: "broken",
    priority: 100,
    match: () => true,
    presentation: () => {
      throw new Error("broken presentation");
    },
    formatActivity: () => {
      throw new Error("broken activity");
    },
    summarizeGroup: () => {
      throw new Error("broken group");
    },
    groupTone: () => {
      throw new Error("broken tone");
    },
  });

  const item = activity("broken");
  assert.deepEqual(registry.resolve("broken", item.args), { kind: "grouped" });
  assert.equal(registry.formatActivity(item), "fallback activity broken");
  const snapshot = group([item]);
  assert.equal(registry.summarizeGroup(snapshot), "fallback group 1");
  assert.equal(registry.groupTone(snapshot), undefined);
  assert.equal(counters.get("cc-style.presentation.adapter.broken.resolve.error"), 1);
  assert.equal(counters.get("cc-style.presentation.adapter.broken.activity.error"), 1);
  assert.equal(counters.get("cc-style.presentation.adapter.broken.group.error"), 1);
  assert.equal(counters.get("cc-style.presentation.adapter.broken.tone.error"), 1);
});

test("default adapters optimize process, subagent and MCP summaries", () => {
  const fallback = (_toolName: string, _args: unknown): ToolPresentation => ({
    kind: "grouped",
  });
  const registry = createDefaultToolPresentationRegistry(fallback);

  const process = activity("process", { action: "output", id: "backend" });
  assert.equal(registry.formatActivity(process), "Process 'backend' output read");
  assert.equal(
    registry.summarizeGroup(group([process])),
    "Process 'backend' output read",
  );

  const starting = group([
    activity("process", { action: "start", name: "api" }, "start-1"),
    activity("process", { action: "start", name: "worker" }, "start-2"),
  ], { status: "collecting", runningCount: 2 });
  assert.equal(
    registry.summarizeGroup(starting),
    "Processes 'api', 'worker' starting",
  );
  assert.equal(registry.groupTone(starting), "customMessageLabel");
  assert.equal(
    registry.groupTone(group(starting.activities as ToolActivity[], { failureCount: 2, runningCount: 0, status: "completed" })),
    "error",
  );

  const stopActivity = activity(
    "process",
    { action: "stop", id: "proc_1" },
    "stop-1",
  );
  stopActivity.result = {
    text: "Stopped process api.",
    truncated: false,
    isError: false,
    details: { result: { info: { name: "api" } } },
  };
  const stopped = group([stopActivity]);
  assert.equal(registry.summarizeGroup(stopped), "Process 'api' stopped");
  assert.equal(registry.groupTone(stopped), undefined);
  assert.equal(
    registry.groupTone(group([stopActivity], { failureCount: 1 })),
    "error",
  );

  const v2Logs = activity("process", { action: "logs", target: { name: "api" } });
  v2Logs.result = {
    text: "Read process logs.",
    truncated: false,
    isError: false,
    details: {
      version: 2,
      action: "logs",
      outcome: "success",
      data: { process: { name: "api" } },
    },
  };
  assert.equal(registry.formatActivity(v2Logs), "Process 'api' logs read");
  assert.equal(registry.summarizeGroup(group([v2Logs])), "Process 'api' logs read");

  const v2Input = activity("process", { action: "input", target: { name: "api" }, text: "x" });
  assert.equal(registry.formatActivity(v2Input), "Process 'api' received input");
  const v2Configure = activity("process", { action: "configure", target: { name: "api" } });
  assert.equal(registry.formatActivity(v2Configure), "Process 'api' updated");

  const processStates = [
    ["start", "started"],
    ["stop", "stopped"],
    ["list", "Listed processes"],
    ["clear", "Cleared finished processes"],
  ] as const;
  for (const [action, expected] of processStates) {
    const item = activity("process", { action, name: "api" });
    assert.equal(
      registry.formatActivity(item),
      action === "list" || action === "clear" ? expected : `Process 'api' ${expected}`,
    );
  }

  const many = group([
    activity("process", { action: "start", name: "api" }, "many-1"),
    activity("process", { action: "start", name: "worker" }, "many-2"),
    activity("process", { action: "start", name: "web" }, "many-3"),
  ]);
  assert.equal(registry.summarizeGroup(many), "3 processes started");

  const quoted = activity("process", {
    action: "start",
    name: "user's api",
  });
  assert.equal(
    registry.summarizeGroup(group([quoted])),
    "Process 'user\\'s api' started",
  );
  assert.equal(
    registry.summarizeGroup(group([quoted], { failureCount: 1 })),
    "Process 'user\\'s api' failed to start",
  );
  assert.equal(
    registry.summarizeGroup(group([quoted], { status: "cancelled" })),
    "Process 'user\\'s api' start cancelled",
  );

  const directCases: Array<[string, unknown, string]> = [
    ["ask_user_question", { questions: [{}, {}] }, "Asked 2 questions"],
    ["web_fetch", { url: "https://example.com/docs" }, "Fetched https://example.com/docs"],
  ];
  for (const [name, args, expected] of directCases) {
    assert.equal(registry.formatActivity(activity(name, args)), expected);
  }

  const subagent = activity("subagent", {
    task: "Review renderer architecture",
    tasks: [{}, {}, {}],
  });
  assert.equal(
    registry.formatActivity(subagent),
    "Delegated 3 agents — 'Review renderer architecture'",
  );
  assert.equal(registry.summarizeGroup(group([subagent])), "Delegated 3 agents — 'Review renderer architecture'");

  const collaboration = [
    ["spawn_agent", { task_name: "review", message: "Audit renderer semantics" }, "Spawned agent 'review' — 'Audit renderer semantics'"],
    ["send_message", { target: "/root/review", message: "Check wording" }, "Sent mailbox message to '/root/review' — 'Check wording'"],
    ["followup_task", { target: "/root/review", message: "Run tests" }, "Queued follow-up task for '/root/review' — 'Run tests'"],
    ["wait_agents", { targets: ["/root/review"] }, "Waited for agent '/root/review'"],
    ["interrupt_agent", { target: "/root/review" }, "Interrupted agent '/root/review'"],
    ["list_agents", { path_prefix: "/root/review" }, "Listed agents under '/root/review'"],
    ["list_subagent_models", { query: "gpt" }, "Searched subagent models for 'gpt'"],
    ["list_subagent_roles", { query: "review" }, "Searched subagent roles for 'review'"],
  ] as const;
  for (const [name, args, completed] of collaboration) {
    const item = activity(name, args);
    assert.equal(registry.formatActivity(item), completed);
    assert.equal(registry.summarizeGroup(group([item])), completed);
  }

  const runningSpawn = activity("spawn_agent", { task_name: "review", message: "Audit renderer semantics" });
  runningSpawn.status = "running";
  assert.equal(registry.formatActivity(runningSpawn), "Spawning agent 'review' — 'Audit renderer semantics'");
  const failedSpawn = activity("spawn_agent", { task_name: "review", message: "Audit renderer semantics" });
  failedSpawn.status = "failed";
  assert.equal(registry.summarizeGroup(group([failedSpawn], { status: "failed", failureCount: 1 })), "Failed to spawn agent 'review' — 'Audit renderer semantics'");
  const mixedAgents = group([
    activity("spawn_agent", { task_name: "review", message: "Audit renderer semantics" }, "agent-1"),
    activity("wait_agents", { targets: ["/root/review", "/root/tests"] }, "agent-2"),
  ]);
  assert.equal(registry.summarizeGroup(mixedAgents), "Spawned agent 'review' — 'Audit renderer semantics', waited for agents '/root/review', '/root/tests'");
  assert.equal(registry.summarizeGroup(group([
    activity("read", { path: "a.ts" }),
    activity("list_subagent_models", { query: "example model" }),
    activity("list_subagent_roles", { query: "worker" }),
    activity("list_agents"),
    activity("spawn_agent", { task_name: "review" }),
  ])), "Read 1 file, delegated 1 task, searched subagent models, searched subagent roles, listed agents");

  const processStringTarget = activity("process", { action: "logs", target: "api" });
  assert.equal(registry.summarizeGroup(group([processStringTarget])), "Process 'api' logs read");

  const rejectedGoal = activity("goal_complete", { summary: "Verified tests" });
  rejectedGoal.result = { text: "Goal completion rejected: no active goal.", isError: false, truncated: false };
  assert.equal(registry.summarizeGroup(group([rejectedGoal])), "Goal completion rejected — 'Verified tests'");

  const workflow = [
    ["goal_complete", { summary: "Verified tests" }, "Completed goal — 'Verified tests'"],
    ["goal_blocked", { reason: "Needs approval" }, "Blocked goal — 'Needs approval'"],
    ["schedule_task", { action: "create", title: "nightly" }, "Scheduled task 'nightly'"],
    ["finish_task", { outcome: "blocked", reason: "approval-required" }, "Reported blocked task — approval-required"],
  ] as const;
  for (const [name, args, expected] of workflow) {
    const item = activity(name, args);
    assert.equal(registry.formatActivity(item), expected);
    assert.equal(registry.summarizeGroup(group([item])), expected);
  }

  const mcp = activity("mcp__github__get_pr", {});
  assert.equal(registry.formatActivity(mcp), "Called github.get_pr");
  assert.equal(registry.summarizeGroup(group([mcp])), "Called github.get_pr");

  const mixed = group([process, activity("read", { path: "a.ts" }, "call-2")]);
  assert.match(registry.summarizeGroup(mixed), /Read 1 file, managed 1 process/);
});

function spawnResult(data: unknown = {
  agent_id: "agt_example",
  task_id: "tsk_example",
  task_path: "/root/review",
  state: "queued",
  fork_turns: "none",
  agent_type: "worker",
  model: "example/model",
  reasoning_effort: "high",
}): NonNullable<ToolActivity["result"]> {
  return {
    text: JSON.stringify(data),
    truncated: false,
    isError: false,
    details: { version: 1, tool: "spawn_agent", outcome: "ok", host_revision: 1, data },
  };
}

test("spawn presentation uses frozen result identity, not requested or inherited model guesses", () => {
  const registry = createDefaultToolPresentationRegistry(() => ({ kind: "grouped" }));
  for (const profile of [
    { model: "requested/other", reasoning_effort: "low" },
    {},
    { agent_type: "reviewer" },
  ]) {
    const item = activity("spawn_agent", {
      task_name: "review", message: "Audit renderer semantics", ...profile,
    });
    item.result = spawnResult();
    const expected = "Delegate to example/model@high · spawned agent 'review' — 'Audit renderer semantics'";
    assert.equal(registry.formatActivity(item), expected);
    assert.equal(registry.summarizeGroup(group([item])), expected);
  }

  for (const effort of [undefined, null, {}, "", "unknown"]) {
    const item = activity("spawn_agent", { task_name: "review", reasoning_effort: "low" });
    item.result = spawnResult({ model: "example/model", reasoning_effort: effort });
    assert.equal(registry.formatActivity(item), "Delegate to example/model · spawned agent 'review'");
  }
});

test("spawn presentation fails closed for absent or malformed identity and retains failure/cancellation", () => {
  const registry = createDefaultToolPresentationRegistry(() => ({ kind: "grouped" }));
  const success = spawnResult();
  const details = success.details as Record<string, unknown>;
  const malformed: unknown[] = [
    undefined, null, [], {},
    { ...details, version: 2 },
    { ...details, tool: "list_agents" },
    { ...details, outcome: "success" },
    { ...details, data: null },
    { ...details, data: [] },
    { ...details, data: { model: {} } },
    { ...details, data: { model: "" } },
    { ...details, data: { model: "bare-model" } },
    { ...details, data: { model: "example/" } },
    { ...details, data: { model: "example/model\nforged" } },
    { ...details, data: { reasoning_effort: "high" } },
    { model: "example/model", reasoning_effort: "high" },
  ];
  for (const value of malformed) {
    const item = activity("spawn_agent", { task_name: "review", model: "requested/model" });
    item.result = { ...success, details: value };
    assert.equal(registry.formatActivity(item), "Spawned agent 'review'");
    assert.equal(registry.summarizeGroup(group([item])), "Spawned agent 'review'");
  }

  const args = { task_name: "review", message: "Audit renderer semantics", model: "requested/model" };
  const pending = activity("spawn_agent", args);
  pending.status = "running";
  assert.equal(registry.formatActivity(pending), "Spawning agent 'review' — 'Audit renderer semantics'");
  const absent = activity("spawn_agent", args);
  assert.equal(registry.formatActivity(absent), "Spawned agent 'review' — 'Audit renderer semantics'");
  const rejected = activity("spawn_agent", args);
  rejected.result = { ...success, details: { ...details, outcome: "rejected", error: { code: "name-conflict", message: "Name exists" } } };
  assert.equal(registry.formatActivity(rejected), "Failed to spawn agent 'review' — 'Audit renderer semantics'");
  assert.equal(registry.summarizeGroup(group([rejected], { status: "failed", failureCount: 1 })), "Failed to spawn agent 'review' — 'Audit renderer semantics'");
  for (const status of ["failed", "cancelled"] as const) {
    const item = activity("spawn_agent", args);
    item.status = status;
    item.result = success;
    const expected = status === "failed"
      ? "Failed to spawn agent 'review' — 'Audit renderer semantics'"
      : "Agent spawn cancelled for 'review' — 'Audit renderer semantics'";
    assert.equal(registry.formatActivity(item), expected);
    assert.equal(registry.summarizeGroup(group([item], { status, failureCount: status === "failed" ? 1 : 0 })), expected);
  }
  const errored = activity("spawn_agent", args);
  errored.result = { ...success, isError: true };
  assert.equal(registry.formatActivity(errored), "Failed to spawn agent 'review' — 'Audit renderer semantics'");
});

test("spawn state changes use new snapshots while identity cache keeps old snapshots stable", async () => {
  const { GroupStore } = await import("../src/grouping.ts");
  const counters = new Map<string, number>();
  const registry = createDefaultToolPresentationRegistry(() => ({ kind: "grouped" }), {
    measure: (_name, action) => action(),
    increment: (name, delta = 1) => counters.set(name, (counters.get(name) ?? 0) + delta),
  });
  const store = new GroupStore({ maxGroups: 10 });
  const args = { task_name: "review", message: "Audit renderer semantics" };
  const pending = store.start("spawn-1", "spawn_agent", args, 1);
  const spawning = "Spawning agent 'review' — 'Audit renderer semantics'";
  assert.equal(registry.formatActivity(pending.activities[0]!), spawning);
  assert.equal(registry.formatActivity(pending.activities[0]!), spawning);
  assert.equal(registry.summarizeGroup(pending), spawning);
  assert.equal(registry.summarizeGroup(pending), spawning);

  store.update("spawn-1", args, spawnResult());
  const admitted = store.latest()!;
  assert.notEqual(admitted.activities[0], pending.activities[0]);
  assert.equal(registry.formatActivity(admitted.activities[0]!), "Delegate to example/model@high · spawning agent 'review' — 'Audit renderer semantics'");
  store.end("spawn-1", spawnResult(), "completed", 2);
  const completed = store.latest()!;
  const delegated = "Delegate to example/model@high · spawned agent 'review' — 'Audit renderer semantics'";
  assert.notEqual(completed, admitted);
  assert.notEqual(completed.activities[0], admitted.activities[0]);
  assert.equal(registry.formatActivity(completed.activities[0]!), delegated);
  assert.equal(registry.formatActivity(completed.activities[0]!), delegated);
  assert.equal(registry.summarizeGroup(completed), delegated);
  assert.equal(registry.summarizeGroup(completed), delegated);
  assert.equal(registry.formatActivity(pending.activities[0]!), spawning);
  assert.equal(registry.summarizeGroup(pending), spawning);
  assert.equal(counters.get("cc-style.presentation.activity.cache-hit"), 3);
  assert.equal(counters.get("cc-style.presentation.group.cache-hit"), 3);
});

test("spawn group and overlay share the adapter and truncate long frozen identities", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const { SelectableCollapsiblePanel } = await import("pi-li-uikit/selectable-collapsible-panel");
  const { DEFAULT_DIFF, DEFAULT_OVERLAY } = await import("../src/config.ts");
  const { createToolGroupOverlayClass } = await import("../src/overlay.ts");
  const { fitGroupSummary } = await import("../src/tool-renderer.ts");
  initTheme("dark");
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  } as unknown as import("@earendil-works/pi-coding-agent").Theme;
  const registry = createDefaultToolPresentationRegistry(() => ({ kind: "grouped" }));
  const spawned = activity("spawn_agent", { task_name: "review", message: "Audit renderer semantics" });
  spawned.result = spawnResult();
  const waiting = activity("wait_agents", { targets: ["/root/review"] }, "wait-1");
  const snapshot = group([spawned, waiting]);
  assert.equal(registry.summarizeGroup(snapshot), "Delegate to example/model@high · spawned agent 'review' — 'Audit renderer semantics', waited for agent '/root/review'");
  const ToolGroupOverlay = createToolGroupOverlayClass(SelectableCollapsiblePanel);
  const view = new ToolGroupOverlay({
    tui: { terminal: { rows: 24, columns: 160, write: () => {} }, requestRender: () => {} } as unknown as import("@earendil-works/pi-tui").TUI,
    theme, group: snapshot, maxResultChars: 5_000, diffColors: DEFAULT_DIFF,
    formatActivity: (item) => registry.formatActivity(item), overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 }, onClose: () => {},
  });
  const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(view.render(160).map(stripAnsi).join("\n"), /Delegate to example\/model@high · spawned agent 'review' — 'Audit renderer semantics'/u);

  const long = activity("spawn_agent", { task_name: "review", message: "Describe ".repeat(30) });
  long.result = spawnResult({ model: `example/${"long-model-".repeat(30)}`, reasoning_effort: "xhigh" });
  const longGroup = group([long]);
  assert.match(registry.formatActivity(long), /@xhigh · spawned agent 'review'/u);
  for (const width of [1, 12, 24, 80]) {
    const rows = fitGroupSummary(longGroup, theme, width, (item) => registry.summarizeGroup(item));
    assert.ok(rows.length <= 2);
    assert.ok(rows.every((line) => visibleWidth(line) <= width));
    assert.match(rows.at(-1) ?? "", /…/u);
  }
  view.updateGroup(longGroup);
  const narrow = view.render(32).map(stripAnsi);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 32));
  assert.match(narrow.join("\n"), /Delegate to/u);
});

test("MCP 5.3 server proxy prefers args.tool and canonical identity survives deferred envelopes", () => {
  const registry = createDefaultToolPresentationRegistry(() => ({ kind: "grouped" }));
  const proxy = activity("mcp__smoke_echo", { tool: "echo", args: { message: "hello" } });
  proxy.result = { text: "hello", truncated: false, isError: false, details: { mode: "call", server: "smoke_echo", tool: "echo", canonicalTool: "smoke_echo_echo", mcpResult: { structuredContent: { message: "hello" } } } };
  assert.equal(registry.formatActivity(proxy), "Called echo");
  const deferred = activity("mcp__smoke_echo", {});
  deferred.result = proxy.result;
  assert.equal(registry.formatActivity(deferred), "Called smoke_echo_echo");
  const failed = activity("mcp__smoke_echo", { tool: "echo" });
  failed.result = { text: "", truncated: false, isError: false, details: { error: "denied" } };
  assert.equal(registry.formatActivity(failed), "Called echo · failed");
});
