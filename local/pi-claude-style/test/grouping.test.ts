import assert from "node:assert/strict";
import test from "node:test";
import { GroupStore } from "../src/grouping.ts";

test("groups consecutive tool calls and deduplicates toolCallId", () => {
  let now = 100;
  const store = new GroupStore({ maxGroups: 10, now: () => now++ });
  const first = store.start("a", "grep", { pattern: "foo" });
  const duplicate = store.start("a", "grep", { pattern: "bar" });
  const second = store.start("b", "read", { path: "x.ts" });

  assert.equal(first.id, duplicate.id);
  assert.equal(second.id, first.id);
  assert.equal(store.list()[0]?.activities.length, 2);
  assert.deepEqual(store.list()[0]?.activities[0]?.args, { pattern: "bar" });
});

test("group subscribers receive live arguments, results, status, and unsubscribe cleanly", () => {
  let now = 100;
  const store = new GroupStore({ maxGroups: 10, now: () => now });
  const group = store.start("live-1", "bash", { command: "echo" });
  const snapshots: Array<ReturnType<GroupStore["getById"]>> = [];
  const unsubscribe = store.subscribe(group.id, (snapshot) => snapshots.push(snapshot));

  now = 200;
  store.update(
    "live-1",
    { command: "echo ready" },
    { text: "rea", truncated: false, isError: false },
  );
  now = 350;
  store.end(
    "live-1",
    { text: "ready", truncated: false, isError: false },
    "completed",
  );

  assert.deepEqual(
    snapshots.map((snapshot) => ({
      command: (snapshot?.activities[0]?.args as { command?: string } | undefined)?.command,
      result: snapshot?.activities[0]?.result?.text,
      status: snapshot?.activities[0]?.status,
      updatedAt: snapshot?.updatedAt,
    })),
    [
      { command: "echo", result: undefined, status: "running", updatedAt: 100 },
      { command: "echo ready", result: "rea", status: "running", updatedAt: 200 },
      { command: "echo ready", result: "ready", status: "completed", updatedAt: 350 },
    ],
  );

  unsubscribe();
  store.closeBoundary();
  assert.equal(snapshots.length, 3);
});

test("a broken group subscriber cannot interrupt tool mutations", () => {
  const store = new GroupStore({ maxGroups: 10, now: () => 100 });
  const group = store.start("observed", "bash", { command: "echo" });
  const unsubscribe = store.subscribe(group.id, () => {
    throw new Error("overlay disposed during paint");
  });

  assert.doesNotThrow(() => {
    store.update("observed", { command: "echo ready" });
    store.end(
      "observed",
      { text: "ready", truncated: false, isError: false },
      "completed",
      200,
    );
  });
  assert.equal(store.getById(group.id)?.activities[0]?.status, "completed");
  unsubscribe();
});

test("creates a new group after visible-text boundary", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const first = store.start("a", "read", {});
  store.end("a", { text: "ok", truncated: false, isError: false }, "completed");
  store.closeBoundary();
  const second = store.start("b", "bash", {});
  assert.notEqual(second.id, first.id);
});

test("retains captured edit details for overlay rendering", () => {
  const store = new GroupStore({ maxGroups: 10 });
  store.start("edit-1", "edit", { path: "x.ts" });
  store.end(
    "edit-1",
    {
      text: "ok",
      truncated: false,
      isError: false,
      details: { diff: "-1 old\n+1 new" },
    },
    "completed",
  );
  assert.deepEqual(store.latest()?.activities[0]?.result?.details, {
    diff: "-1 old\n+1 new",
  });
});

test("keeps consecutive tool-only model turns in one group", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const first = store.start("a", "read", {});
  store.end("a", { text: "ok", truncated: false, isError: false }, "completed");
  const second = store.start("b", "grep", {});
  assert.equal(second.id, first.id);
  assert.equal(store.latest()?.activities.length, 2);
});

test("marks failures and cancels running activities on finish", () => {
  const store = new GroupStore({ maxGroups: 10 });
  store.start("a", "bash", {});
  store.start("b", "read", {});
  store.end("a", { text: "bad", truncated: false, isError: true }, "failed");
  store.finish("cancelled");

  const group = store.latest();
  assert.equal(group?.failureCount, 1);
  assert.equal(group?.activities[1]?.status, "cancelled");
});

test("releases payloads past the limit but keeps every row renderable", () => {
  const store = new GroupStore({ maxGroups: 2 });
  for (const id of ["a", "b", "c"]) {
    store.start(id, "read", {});
    store.end(
      id,
      { text: `${id} output`, truncated: false, isError: false },
      "completed",
    );
    store.closeBoundary();
  }
  // Dropping a group would make its row render as zero lines, resizing the
  // transcript above the fold and forcing a full-screen repaint.
  assert.deepEqual(
    store.list().map((group) => group.anchorToolCallId),
    ["a", "b", "c"],
  );
  const oldest = store.getByToolCallId("a");
  assert.equal(oldest?.pruned, true);
  assert.equal(oldest?.activities[0]?.result?.text, "");
  assert.equal(store.getByToolCallId("c")?.activities[0]?.result?.text, "c output");
  // Only the inspectable transcript drops what it can no longer show.
  assert.deepEqual(
    store.listInspectable().map((group) => group.anchorToolCallId),
    ["b", "c"],
  );
});

test("can preserve renderer invalidators while rebuilding stored data", () => {
  const store = new GroupStore({ maxGroups: 2 });
  let invalidations = 0;
  store.start("a", "read", {});
  store.registerRenderer("a", () => invalidations++);
  store.clear({ preserveInvalidators: true });
  store.invalidateAll();
  assert.equal(invalidations, 1);
});

test("keeps only the latest renderer invalidator for each tool call", () => {
  const store = new GroupStore({ maxGroups: 2 });
  let staleInvalidations = 0;
  let currentInvalidations = 0;

  store.registerRenderer("a", () => staleInvalidations++);
  store.registerRenderer("a", () => currentInvalidations++);
  store.invalidateAll();

  assert.equal(staleInvalidations, 0);
  assert.equal(currentInvalidations, 1);
});

test("unloaded tool renderers release their callback bindings", () => {
  const store = new GroupStore({ maxGroups: 2 });
  let kept = 0, unloaded = 0;
  store.registerRenderer("kept", () => kept++);
  store.registerRenderer("unloaded", () => unloaded++);
  store.retainRenderers(new Set(["kept"]));
  store.invalidateAll();
  assert.equal(kept, 1); assert.equal(unloaded, 0);
});

test("bounds renderer registration during reentrant redraws", () => {
  const store = new GroupStore({ maxGroups: 2 });
  let invalidations = 0;
  const installRenderer = () => {
    store.registerRenderer("a", () => {
      invalidations++;
      installRenderer();
    });
  };

  store.start("a", "read", {});
  installRenderer();
  store.update("a", {});
  store.update("a", {});

  assert.equal(invalidations, 2);
});

test("can suppress invalidations for a bounded batch", () => {
  const store = new GroupStore({ maxGroups: 2 });
  let invalidations = 0;
  store.registerRenderer("a", () => invalidations++);

  store.withoutInvalidation(() => {
    store.start("a", "read", {});
    store.end(
      "a",
      { text: "ok", truncated: false, isError: false },
      "completed",
    );
    store.closeBoundary();
    store.invalidateAll();
  });

  assert.equal(invalidations, 0);
  store.invalidateAll();
  assert.equal(invalidations, 1);
});

test("can keep invalidations dormant until historical restore completes", () => {
  const store = new GroupStore({
    maxGroups: 2,
    invalidationsEnabled: false,
  });
  let invalidations = 0;
  store.registerRenderer("a", () => invalidations++);

  store.start("a", "read", {});
  store.end(
    "a",
    { text: "ok", truncated: false, isError: false },
    "completed",
  );
  store.invalidateAll();
  assert.equal(invalidations, 0);

  store.setInvalidationsEnabled(true);
  store.invalidateAll();
  assert.equal(invalidations, 1);
});

test("retained result payloads obey an independent UTF-8 byte budget", () => {
  const store = new GroupStore({ maxGroups: 10, maxCapturedBytes: 10 });
  store.start("a", "read", {});
  store.end("a", { text: "123456", truncated: false, isError: false }, "completed");
  store.closeBoundary();
  store.start("b", "read", {});
  store.end("b", { text: "你好", truncated: false, isError: false }, "completed");

  assert.ok(store.capturedPayloadBytes() <= 10);
  assert.equal(store.getByToolCallId("a")?.activities[0]?.result?.text, "");
  assert.equal(store.getByToolCallId("a")?.activities[0]?.result?.truncated, true);
  assert.equal(store.getByToolCallId("b")?.activities[0]?.result?.text, "你好");
});

test("the capture budget is a hard bound for arguments before a result arrives", () => {
  const store = new GroupStore({ maxGroups: 10, maxCapturedBytes: 4 });
  store.start("a", "read", { path: "a very long path" });

  assert.ok(store.capturedPayloadBytes() <= 4);
  assert.equal(store.getByToolCallId("a")?.activities[0]?.args, undefined);
  assert.equal(store.getByToolCallId("a")?.pruned, true);
});

test("minimal pruned rows do not accumulate outside a zero-byte budget", () => {
  const store = new GroupStore({ maxGroups: 10, maxCapturedBytes: 0 });
  for (let index = 0; index < 100; index++) {
    store.start(String(index), "read", {});
    store.closeBoundary();
  }

  assert.equal(store.capturedPayloadBytes(), 0);
});

test("batched invalidations coalesce repeated mutations for one renderer", async () => {
  const store = new GroupStore({ maxGroups: 10, batchInvalidations: true });
  let invalidations = 0;
  store.registerRenderer("a", () => invalidations++);
  store.start("a", "read", {});
  store.update("a", { step: 1 });
  store.update("a", { step: 2 });
  assert.equal(invalidations, 0);

  await Promise.resolve();
  assert.equal(invalidations, 1);
});

test("isolates important activities between grouped timeline items", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const before = store.start("read-1", "read", {});
  store.end(
    "read-1",
    { text: "ok", truncated: false, isError: false },
    "completed",
  );
  const web = store.start(
    "web-1",
    "web_search",
    { query: "weather" },
    100,
    "web-search",
  );
  store.end(
    "web-1",
    { text: "results", truncated: false, isError: false },
    "completed",
    7_100,
  );
  const after = store.start("bash-1", "bash", {});

  assert.notEqual(before.id, web.id);
  assert.notEqual(web.id, after.id);
  assert.deepEqual(
    store.list().map((item) => item.presentation),
    ["grouped", "web-search", "grouped"],
  );
});

test("keeps consecutive important activities separate and skips questions for latest inspection", () => {
  const store = new GroupStore({ maxGroups: 10 });
  store.start("web-1", "web_search", {}, 100, "web-search");
  store.end(
    "web-1",
    { text: "ok", truncated: false, isError: false },
    "completed",
    200,
  );
  store.start("question-1", "ask_user_question", {}, 300, "question");
  store.end(
    "question-1",
    {
      text: "answered",
      truncated: false,
      isError: false,
      details: { answers: [], cancelled: false },
    },
    "completed",
    400,
  );

  assert.equal(store.list().length, 2);
  assert.equal(store.latest()?.presentation, "question");
  assert.equal(store.latestInspectable()?.presentation, "web-search");
  assert.deepEqual(
    store.listInspectable().map((item) => item.presentation),
    ["web-search"],
  );
});

test("bulk restore enforces group and payload budgets once at the end", () => {
  const store = new GroupStore({ maxGroups: 500, maxCapturedBytes: 4_000 });

  store.bulkRestore((writer) => {
    for (let item = 0; item < 10_000; item++) {
      const id = `bulk-${item}`;
      writer.start(id, "read", { path: `file-${item}.ts` }, item);
      writer.end(
        id,
        { text: `result-${item}`, truncated: false, isError: false },
        "completed",
        item + 1,
      );
      writer.closeBoundary();
    }
  });

  assert.equal(store.groupCount(), 10_000);
  // maxGroups and maxCapturedBytes are independent upper bounds. The byte
  // budget may prune more than the group-count budget when payloads are large.
  assert.ok(store.listInspectable().length <= 500);
  assert.ok(store.listInspectable().length > 0);
  assert.ok(store.capturedPayloadBytes() <= 4_000);
  assert.equal(store.getByToolCallId("bulk-0")?.pruned, true);
  assert.equal(store.getByToolCallId("bulk-9999")?.pruned, false);
});

test("a late result rewinds payload eviction to preserve the hard byte bound", () => {
  const store = new GroupStore({ maxGroups: 10, maxCapturedBytes: 10 });
  store.start("old-running", "read", undefined);
  store.closeBoundary();
  for (const id of ["new-1", "new-2"]) {
    store.start(id, "read", undefined);
    store.end(id, { text: "12345678", truncated: false, isError: false }, "completed");
    store.closeBoundary();
  }

  store.end(
    "old-running",
    { text: "a late result larger than the remaining budget", truncated: false, isError: false },
    "completed",
  );

  assert.ok(store.capturedPayloadBytes() <= 10);
  assert.equal(store.getByToolCallId("old-running")?.activities[0]?.result?.text, "");
});
