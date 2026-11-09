import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTool,
  currentGroupActivity,
  formatCurrentActivity,
  summarizeGroup,
} from "../src/semantics.ts";
import type { ToolActivity } from "../src/types.ts";
import type { ToolGroupSnapshot } from "../src/types.ts";

function group(
  status: ToolGroupSnapshot["status"],
  names: string[],
  failed = 0,
): ToolGroupSnapshot {
  return {
    id: "g",
    anchorToolCallId: "0",
    presentation: "grouped",
    status,
    createdAt: 0,
    updatedAt: 1,
    failureCount: failed,
    runningCount: status === "collecting" ? names.length : 0,
    activities: names.map((toolName, index) => ({
      id: `${index}`,
      groupId: "g",
      toolName,
      args: {},
      status: index < failed ? "failed" : status === "collecting" ? "running" : "completed",
      startedAt: 0,
    })),
  };
}

test("classifies built-in and named third-party tools", () => {
  assert.equal(classifyTool("grep"), "search");
  assert.equal(classifyTool("subagent_spawn"), "subagent");
  for (const name of ["spawn_agent", "send_message", "followup_task", "wait_agents", "interrupt_agent", "list_agents", "list_subagent_models", "list_subagent_roles"]) assert.equal(classifyTool(name), "subagent");
  assert.equal(classifyTool("process"), "process");
  assert.equal(classifyTool("exec_command"), "bash");
  assert.equal(classifyTool("shell_command"), "bash");
  assert.equal(classifyTool("mcp__github__search"), "mcp");
  assert.equal(classifyTool("something_new"), "unknown");
});

test("renders Claude-style running and past tense summaries", () => {
  assert.equal(
    summarizeGroup(group("collecting", ["grep", "read", "bash"])),
    "Searching for 1 pattern, reading 1 file, running 1 shell command",
  );
  assert.equal(
    summarizeGroup(group("completed", ["grep", "read", "bash"])),
    "Searched for 1 pattern, read 1 file, ran 1 shell command",
  );
});

test("keeps failures visible", () => {
  assert.match(summarizeGroup(group("failed", ["bash", "bash"], 1)), /1 failed$/);
});

test("discovery summaries describe queries without counting delegated tasks", () => {
  const cases = [
    ["list_subagent_models", "Searching subagent models", "Searched subagent models"],
    ["list_subagent_roles", "Searching subagent roles", "Searched subagent roles"],
    ["list_agents", "Listing agents", "Listed agents"],
  ] as const;
  for (const [name, running, completed] of cases) {
    assert.equal(summarizeGroup(group("collecting", [name])), running);
    assert.equal(summarizeGroup(group("completed", [name])), completed);
  }
  assert.equal(summarizeGroup(group("completed", ["read", "list_subagent_models", "list_subagent_roles", "list_agents", "spawn_agent"])),
    "Read 1 file, delegated 1 task, searched subagent models, searched subagent roles, listed agents");
  assert.equal(summarizeGroup(group("completed", ["list_subagent_models", "list_subagent_models"])), "Ran 2 subagent model searches");
  assert.equal(summarizeGroup(group("completed", ["spawn_agent", "followup_task"])), "Delegated 2 tasks");
  assert.equal(summarizeGroup(group("failed", ["list_subagent_models"], 1)), "Searched subagent models · 1 failed");
});

function activity(toolName: string, args: unknown): ToolActivity {
  return {
    id: toolName,
    groupId: "g",
    toolName,
    args,
    status: "running",
    startedAt: 1,
  };
}

const memoryDirectory = `/custom agent/pi-cc-memory/projects/${"ab".repeat(32)}/memory/`;

function memorySummary(...activities: ToolActivity[]): string {
  return summarizeGroup({ ...group("completed", []), activities });
}

test("classifies cc-memory topic paths as memory operations without probing disk", () => {
  for (const directory of [memoryDirectory, memoryDirectory.replaceAll("/", "\\"),
    `~/.pi-next/agent/pi-cc-memory/projects/${"A".repeat(64)}/memory/`]) {
    const path = `${directory}project-stock-host.md`;
    assert.equal(memorySummary(activity("read", { path })), "Read 1 memory");
    assert.equal(memorySummary(activity("write", { path, content: "new or replacement" })), "Saved 1 memory");
    assert.equal(memorySummary(activity("edit", { path })), "Updated 1 memory");
    assert.equal(formatCurrentActivity(activity("edit", { path })), 'Update memory "project-stock-host"');
  }
  assert.equal(memorySummary(activity("read", { path: `${memoryDirectory}./feedback-ui.md` })), "Read 1 memory");
});

test("keeps files outside the exact cc-memory topic grammar in their original classes", () => {
  const paths = [
    "/tmp/memory/project.md", "/tmp/MEMORY.md",
    memoryDirectory.replace("pi-cc-memory/", "my-pi-cc-memory/") + "topic.md",
    memoryDirectory.replace("projects/", "project/") + "topic.md",
    memoryDirectory.replace("ab".repeat(32), "a".repeat(63)) + "topic.md",
    memoryDirectory.replace("ab".repeat(32), "a".repeat(65)) + "topic.md",
    memoryDirectory.replace("ab".repeat(32), "g".repeat(64)) + "topic.md",
    memoryDirectory.replace("memory/", "memories/") + "topic.md",
    `${memoryDirectory}../topic.md`, `${memoryDirectory}nested/topic.md`,
    `${memoryDirectory}topic.txt`, `${memoryDirectory}topic.md.bak`,
    `${memoryDirectory}MEMORY.md/extra`, `${memoryDirectory}topic.md\0`,
  ];
  for (const path of paths) {
    assert.equal(memorySummary(activity("read", { path })), "Read 1 file", path);
    assert.equal(memorySummary(activity("write", { path })), "Wrote 1 file", path);
    assert.equal(memorySummary(activity("edit", { path })), "Edited 1 file", path);
  }
  assert.equal(memorySummary(activity("read", {})), "Read 1 file");
  assert.equal(memorySummary(activity("read", { path: null })), "Read 1 file");
  assert.equal(memorySummary(activity("read_file", { path: `${memoryDirectory}topic.md` })), "Read 1 file");
});

test("classifies MEMORY.md separately and folds it only with topics in its own directory", () => {
  const index = { path: `${memoryDirectory}MEMORY.md` };
  const topic = { path: `${memoryDirectory}topic.md` };
  assert.equal(memorySummary(activity("read", index)), "Read memory index");
  assert.equal(memorySummary(activity("write", index)), "Updated memory index");
  assert.equal(memorySummary(activity("edit", index)), "Updated memory index");
  assert.equal(memorySummary(activity("read", index), activity("read", topic)), "Read 1 memory");
  assert.equal(memorySummary(activity("write", topic), activity("edit", index)), "Saved 1 memory");
  assert.equal(memorySummary(activity("edit", index), activity("edit", topic)), "Updated 1 memory");
  assert.equal(memorySummary(activity("read", index), activity("write", topic), activity("write", index)), "Saved 1 memory");
  assert.equal(memorySummary(activity("read", { path: `${memoryDirectory}memory.md` })), "Read 1 memory");
  assert.equal(memorySummary(activity("write", { path: `${memoryDirectory.replace("ab".repeat(32), "cd".repeat(32))}topic.md` }), activity("edit", index)), "Saved 1 memory, updated memory index");
  assert.equal(memorySummary(activity("ctx_memory", { action: "write" }), activity("edit", index)), "Saved 1 memory, updated memory index");
});

test("formats the current operation for grouped tool kinds", () => {
  assert.equal(
    formatCurrentActivity(
      activity("bash", { command: "git diff --stat\nignored" }),
    ),
    "$ git diff --stat ignored",
  );
  assert.equal(
    formatCurrentActivity(
      activity("exec_command", { cmd: "x".repeat(120) }),
    ),
    `$ ${"x".repeat(99)}…`,
  );
  assert.equal(
    formatCurrentActivity(activity("read", { path: "src/a.ts" })),
    "Read src/a.ts",
  );
  assert.equal(
    formatCurrentActivity(
      activity("grep", { pattern: "needle", path: "src" }),
    ),
    'Search "needle" in src',
  );
  assert.equal(
    formatCurrentActivity(activity("ls", { path: "packages" })),
    "List packages",
  );
  assert.equal(
    formatCurrentActivity(activity("mcp__github__search", { token: "secret" })),
    "Call github.search",
  );
  assert.equal(
    formatCurrentActivity(activity("subagent", { task: "review changes" })),
    "Subagent review changes",
  );
});

test("selects the latest activity that is still running", () => {
  const snapshot = group("collecting", ["read", "bash", "grep"]);
  snapshot.activities[1]!.status = "completed";
  assert.equal(currentGroupActivity(snapshot)?.toolName, "grep");
  snapshot.activities[2]!.status = "completed";
  assert.equal(currentGroupActivity(snapshot)?.toolName, "read");
});

test("classifies Magic Context tools instead of falling through to grep", () => {
  assert.equal(classifyTool("ctx_search"), "memory");
  assert.equal(classifyTool("ctx_memory"), "memory");
  assert.equal(classifyTool("ctx_note"), "note");
  assert.equal(classifyTool("ctx_expand"), "context");
  assert.equal(classifyTool("ctx_reduce"), "context");
  assert.equal(classifyTool("todowrite"), "todo");
});

test("summarizes every Magic Context action without misreporting it", () => {
  const snapshot = {
    id: "g",
    anchorToolCallId: "1",
    presentation: "grouped",
    status: "completed",
    createdAt: 0,
    updatedAt: 1,
    failureCount: 0,
    runningCount: 0,
    activities: [
      { id: "1", groupId: "g", toolName: "ctx_search", args: { query: "layout" }, status: "completed", startedAt: 0 },
      { id: "2", groupId: "g", toolName: "ctx_memory", args: { action: "archive", ids: [12, 18] }, status: "completed", startedAt: 0 },
      { id: "3", groupId: "g", toolName: "ctx_note", args: { action: "dismiss", note_id: 4 }, status: "completed", startedAt: 0 },
      { id: "4", groupId: "g", toolName: "ctx_reduce", args: { drop: "20-21" }, status: "completed", startedAt: 0 },
    ],
  } as unknown as Parameters<typeof summarizeGroup>[0];
  assert.equal(
    summarizeGroup(snapshot),
    "Searched context, archived 2 memories, dismissed 1 note, queued 1 context drop",
  );
});

test("summarizes individual Magic Context operations", () => {
  const summary = (toolName: string, args: unknown) => summarizeGroup({
    id: "g",
    anchorToolCallId: "1",
    presentation: "grouped",
    status: "completed",
    createdAt: 0,
    updatedAt: 1,
    failureCount: 0,
    runningCount: 0,
    activities: [
      { id: "1", groupId: "g", toolName, args, status: "completed", startedAt: 0 },
    ],
  } as unknown as Parameters<typeof summarizeGroup>[0]);

  const cases: Array<[string, unknown, string]> = [
    ["ctx_search", { query: "layout" }, "Searched context"],
    ["ctx_memory", { action: "write", content: "fact" }, "Saved 1 memory"],
    ["ctx_memory", { action: "list" }, "Listed memories"],
    ["ctx_memory", { action: "get", ids: [1, 2] }, "Read 2 memories"],
    ["ctx_memory", { action: "update", ids: [1] }, "Updated 1 memory"],
    ["ctx_memory", { action: "archive", ids: [1, 2] }, "Archived 2 memories"],
    ["ctx_memory", { action: "merge", ids: [1, 2] }, "Merged 2 memories"],
    ["ctx_note", { action: "write", content: "later" }, "Saved 1 note"],
    ["ctx_note", { action: "write", content: "later", surface_condition: "When released" }, "Saved 1 smart note"],
    ["ctx_note", { action: "read" }, "Read notes"],
    ["ctx_note", { action: "update", note_id: 4 }, "Updated 1 note"],
    ["ctx_note", { action: "dismiss", note_id: 4 }, "Dismissed 1 note"],
    ["ctx_expand", { start: 3, end: 9 }, "Expanded 1 context range"],
    ["ctx_reduce", { drop: "12-18" }, "Queued 1 context drop"],
  ];
  for (const [toolName, args, expected] of cases) {
    assert.equal(summary(toolName, args), expected);
  }
});

test("formats action-specific Magic Context detail rows", () => {
  const item = (toolName: string, args: unknown) => ({
    id: "1",
    groupId: "g",
    toolName,
    args,
    status: "running" as const,
    startedAt: 0,
  });

  assert.equal(
    formatCurrentActivity(item("ctx_search", {
      query: "spinner layout",
      sources: ["memory", "note"],
    })),
    'Search memories + notes "spinner layout"',
  );

  const memoryCases: Array<[unknown, string]> = [
    [{ action: "write", content: "prefers fixed columns" }, 'Save memory "prefers fixed columns"'],
    [{ action: "list", category: "ARCHITECTURE" }, "List ARCHITECTURE memories"],
    [{ action: "get", ids: [12, 18] }, "Read memories #12, #18"],
    [{ action: "update", ids: [12], content: "new wording" }, 'Update memory #12 "new wording"'],
    [{ action: "archive", ids: [12, 18] }, "Archive memories #12, #18"],
    [{ action: "merge", ids: [12, 18] }, "Merge memories #12, #18"],
  ];
  for (const [args, expected] of memoryCases) {
    assert.equal(formatCurrentActivity(item("ctx_memory", args)), expected);
  }

  const noteCases: Array<[unknown, string]> = [
    [{ content: "check the overlay" }, 'Save note "check the overlay"'],
    [{ action: "write", content: "retry later", surface_condition: "When PR #42 is merged" }, 'Save smart note "retry later"'],
    [{ action: "read", filter: "pending" }, "Read pending notes"],
    [{ action: "update", note_id: 4, content: "new text" }, 'Update note #4 "new text"'],
    [{ action: "dismiss", note_id: 4 }, "Dismiss note #4"],
  ];
  for (const [args, expected] of noteCases) {
    assert.equal(formatCurrentActivity(item("ctx_note", args)), expected);
  }

  assert.equal(
    formatCurrentActivity(item("ctx_expand", { message: 7 })),
    "Expand message §7§",
  );
  assert.equal(
    formatCurrentActivity(item("ctx_expand", { start: 3, end: 9, verbose: true })),
    "Expand messages §3§–§9§ · verbose",
  );
  assert.equal(
    formatCurrentActivity(item("ctx_reduce", { drop: "12-18, 21" })),
    "Queue context drops §12§–§18§, §21§",
  );
});

test("classifies the tools that were previously left rendering natively", () => {
  // rpiv-todo registers the bare name; it used to fall through to "unknown"
  // and render its own full-height block.
  assert.equal(classifyTool("todo"), "todo");
  assert.equal(classifyTool("todowrite"), "todo");
  for (const name of ["goal_complete", "goal_blocked", "plan_mode_question", "plan_mode_complete"]) {
    assert.equal(classifyTool(name), "unknown", name);
  }
});

test("labels workflow tools by their outcome", () => {
  const activity = (toolName: string, args: unknown) => ({
    id: "1", groupId: "g", toolName, args, status: "running" as const, startedAt: 0,
  });
  assert.equal(
    formatCurrentActivity(activity("goal_complete", { summary: "spinner no longer jumps" })),
    'Goal complete "spinner no longer jumps"',
  );
  assert.equal(
    formatCurrentActivity(activity("goal_blocked", { reason: "needs a decision" })),
    'Goal blocked "needs a decision"',
  );
  assert.equal(formatCurrentActivity(activity("plan_mode_complete", {})), "Plan ready");
  assert.equal(
    formatCurrentActivity(activity("todo", { action: "update", title: "fix the layout" })),
    'Todo update "fix the layout"',
  );
});

test("mcp gateway tools classify as mcp and show their real target", () => {
  assert.equal(classifyTool("mcp"), "mcp");
  assert.equal(classifyTool("mcpScript"), "mcp");

  const activity = (toolName: string, args: Record<string, unknown>): ToolActivity => ({
    id: "1",
    groupId: "g",
    toolName,
    args,
    status: "running",
    startedAt: 0,
  });

  // The gateway's real target lives in its arguments, not the tool name.
  assert.equal(
    formatCurrentActivity(activity("mcp", { tool: "xcodebuild_list_sims" })),
    "Call xcodebuild_list_sims",
  );
  assert.equal(
    formatCurrentActivity(activity("mcp", { search: "notes" })),
    'MCP search "notes"',
  );
  assert.equal(
    formatCurrentActivity(activity("mcp", { describe: "tolaria_get_note" })),
    "MCP describe tolaria_get_note",
  );
  assert.equal(
    formatCurrentActivity(activity("mcpScript", { code: "await tools.search({ query: 'x' })" })),
    `MCP script "await tools.search({ query: 'x' })"`,
  );
  // Named registrations keep the friendly-name path.
  assert.equal(
    formatCurrentActivity(activity("mcp__github__search", {})),
    "Call github.search",
  );
});
