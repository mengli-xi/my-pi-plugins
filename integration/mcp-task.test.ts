import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "../fork/pi-mcp-adapter/index.ts";
import { appServer } from "./mcp/server.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { frozenTaskResultsFromBranch, frozenTaskResultEntry, pendingTasksFromBranch, taskRecoveryFromSession, taskCheckpointEntry } from "../fork/pi-mcp-adapter/task-entries.ts";
import { assertDurableFile, assertMailboxAccepted, collaborators, componentProducer, deferred, mcpFixture, until } from "./mcp/harness.ts";

/** The remote execution is the actor fake. Registry, source records, Inject
 * acceptance/fsync/recovery, SDK queues and provider projection are production. */
function task(source: ReturnType<typeof componentProducer>, id: string, body: string) {
  const outcome = deferred<any>();
  let renders = 0;
  const delivery = source.registry.capture();
  const done = source.registry.start({ server: "demo", tool: "build", taskId: id, delivery,
    execution: { settle: () => outcome.promise, cancel: async () => {} } as any,
    render: async () => { renders++; return { content: [{ type: "text", text: body }], details: {} }; },
    guard: async value => ({ content: [{ type: "text", text: value }], details: {} }),
  });
  return { done, delivery, get renders() { return renders; }, finish() { outcome.resolve({ outcome: { status: "completed", result: { content: [] } } }); } };
}

test("new Task registries → real Inject: two results coalesce behind a real faux request with CC/Goal loaded", async () => {
  const f = mcpFixture();
  const source = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  const gate = deferred<void>();
  try {
    runtime = await f.start([...(await collaborators()), source.factory]);
    await runtime.session.prompt("Seed", { source: "rpc" });
    let entered = false;
    f.respond(async () => { if (!entered) { entered = true; await gate.promise; } return fauxAssistantMessage("TASK_BATCH_OK"); });
    const baseline = f.requests.length;
    const request = runtime.session.prompt("Wait for both background results", { source: "rpc" });
    await until(() => entered, "provider gate");
    const first = task(source, "one", "TASK_ONE_EXACT"), second = task(source, "two", "TASK_TWO_EXACT");
    first.finish(); second.finish();
    await Promise.all([first.done, second.done]);
    assert.equal(source.accepted, 2, "source ACKs follow actual durable puts while the first provider request is still pending");
    assertMailboxAccepted(f.agentDir, runtime.session.sessionManager, first.delivery.deliveryId);
    assertMailboxAccepted(f.agentDir, runtime.session.sessionManager, second.delivery.deliveryId);
    assertDurableFile(runtime.session.sessionManager, first.delivery.deliveryId);
    assertDurableFile(runtime.session.sessionManager, second.delivery.deliveryId);
    gate.resolve();
    await request;
    await until(() => f.requests.some(messages => JSON.stringify(messages).includes("TASK_ONE_EXACT") && JSON.stringify(messages).includes("TASK_TWO_EXACT")), "coalesced Task projection");
    await runtime.session.waitForIdle();
    const projections = f.requests.slice(baseline).filter(messages => JSON.stringify(messages).includes("TASK_ONE_EXACT"));
    assert.equal(projections.length, 1);
    assert.ok(JSON.stringify(projections[0]).includes("TASK_TWO_EXACT"));
    assert.equal(f.requests.length, baseline + 2, "both completed Tasks share one continuation request, not native followUp per Task");
    const entries = runtime.session.sessionManager.getBranch();
    assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 2);
    assert.equal(first.renders, 1); assert.equal(second.renders, 1);
    assert.deepEqual(f.errors, []);
  } finally { gate.resolve(); await runtime?.dispose(); f.cleanup(); }
});

test("active Goal and two MCP Task results share the real continuation request, then Goal completes", async () => {
  const f = mcpFixture();
  const source = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  const gate = deferred<void>();
  try {
    runtime = await f.start([source.factory, ...(await collaborators())]);
    let entered = false, completed = false;
    f.respond(async messages => {
      if (!entered) { entered = true; await gate.promise; return fauxAssistantMessage("Waiting for the two MCP task results."); }
      if (!completed) {
        const body = messages.map(message => typeof message.content === "string" ? message.content
          : message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
        assert.ok(body.includes("GOAL_TASK_ONE") && body.includes("GOAL_TASK_TWO"), "Goal continuation cannot run ahead of the coalesced Task batch");
        const id = [...body.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)].at(-1)?.[1];
        assert.ok(id, "the actual Goal producer supplies its current goal ID");
        completed = true;
        return fauxAssistantMessage(fauxToolCall("goal_complete", { goal_id: id, summary: "Both MCP task results were consumed." }));
      }
      return fauxAssistantMessage("GOAL_MCP_DONE");
    });
    const kickoff = runtime.session.prompt("/goal Consume both MCP task results and finish", { source: "rpc" });
    await until(() => entered, "real Goal kickoff");
    const one = task(source, "goal-one", "GOAL_TASK_ONE"), two = task(source, "goal-two", "GOAL_TASK_TWO");
    one.finish(); two.finish(); await Promise.all([one.done, two.done]);
    assert.equal(source.accepted, 2);
    gate.resolve(); await kickoff;
    await until(() => completed, "Goal completion tool call");
    await runtime.session.waitForIdle();
    const state = runtime.session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "goal-state") as any;
    assert.equal(state?.data?.goal, null, "the completed Goal is retired by its real completion tool");
    const completion = runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "goal_complete");
    assert.ok(completion && completion.role === "toolResult" && !completion.isError);
    assert.match(JSON.stringify(completion.content), /Goal complete:/);
    assert.equal(f.requests.length, 2, "Goal kickoff and one shared continuation are the only requests; terminate:true completion needs no extra model call");
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 2);
    assert.deepEqual(f.errors, []);
  } finally { gate.resolve(); await runtime?.dispose(); f.cleanup(); }
});

test("a frozen Task outcome survives real writer rejection; a new registry re-puts identical bytes without remote execution/render", async () => {
  const f = mcpFixture();
  const first = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([first.factory]);
    await runtime.session.prompt("Persist original session", { source: "rpc" });
    const result = task(first, "recover", "TASK_FROZEN_RECOVERY");
    const brokenSnapshot = join(f.agentDir, "mailbox", "v1", runtime.session.sessionManager.getSessionId(), "pending.json");
    assert.equal(existsSync(brokenSnapshot), false);
    mkdirSync(brokenSnapshot, { recursive: true }); // Real disk fault, not a replacement put/acceptance implementation.
    result.finish(); await result.done;
    assert.equal(first.accepted, 0);
    const manager = runtime.session.sessionManager;
    const sessionId = manager.getSessionId();
    const frozen = frozenTaskResultsFromBranch(manager.getBranch(), sessionId);
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].anchorEntryId, result.delivery.anchorEntryId);
    assert.equal(pendingTasksFromBranch(manager.getBranch(), sessionId).length, 0, "completed source record must not resume the remote Task");
    const bytes = JSON.stringify(frozen[0].message);
    const file = manager.getSessionFile()!;
    await runtime.dispose();
    rmSync(brokenSnapshot, { recursive: true });
    const second = componentProducer();
    runtime = await f.start([second.factory], SessionManager.open(file));
    const baseline = f.requests.length;
    await second.registry.restoreResult(frozen[0]);
    assert.equal(second.accepted, 1);
    assertMailboxAccepted(f.agentDir, runtime.session.sessionManager, frozen[0].deliveryId);
    assert.equal(f.requests.length, baseline, "recovered acceptance is held until trusted input");
    await runtime.session.prompt("Resume this original session", { source: "rpc" });
    await until(() => JSON.stringify(f.requests.at(-1)).includes("TASK_FROZEN_RECOVERY"), "frozen Task projection");
    await runtime.session.waitForIdle();
    const native = runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result");
    assert.equal(native.length, 1);
    assert.equal(JSON.stringify({ customType: (native[0] as any).customType, display: (native[0] as any).display, content: (native[0] as any).content, details: (native[0] as any).details }), bytes);
    assert.equal(result.renders, 1, "source recovery never invokes the old renderer or remote tool again");
    await second.registry.restoreResult(frozen[0]);
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 1, "same key/bytes is transport-idempotent after fulfillment");
    assertDurableFile(runtime.session.sessionManager, result.delivery.deliveryId);
    const foreign = SessionManager.create(f.root, `${f.root}/forked-sessions`);
    foreign.appendCustomEntry("mcp-task-v1", { version: 1, kind: "result", sessionId, ...frozen[0] });
    assert.deepEqual(frozenTaskResultsFromBranch(foreign.getBranch(), foreign.getSessionId()), [], "a fork/new session cannot claim an original session outcome");
    assert.deepEqual(f.errors, []);
  } finally { await runtime?.dispose(); f.cleanup(); }
});

test("a failed-put frozen checkpoint ancestor cannot authorize a new sibling after replacement", async () => {
  const f = mcpFixture();
  const first = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([first.factory]);
    await runtime.session.prompt("Frozen checkpoint origin", { source: "rpc" });
    const result = task(first, "checkpoint-ancestor", "FROZEN_CHECKPOINT_ANCESTOR_LEAK");
    const broken = join(f.agentDir, "mailbox", "v1", runtime.session.sessionManager.getSessionId(), "pending.json");
    mkdirSync(broken, { recursive: true });
    result.finish(); await result.done;
    assert.equal(first.accepted, 0);
    rmSync(broken, { recursive: true });
    const shared = runtime.session.sessionManager.appendCustomEntry("foreign-owner-checkpoint", { actor: "fixture" });
    await runtime.session.prompt("Original branch after frozen checkpoint", { source: "rpc" });
    await runtime.session.navigateTree(shared, { summarize: false });
    await runtime.session.prompt("New B below the old frozen checkpoint", { source: "rpc" });
    const file = runtime.session.sessionManager.getSessionFile()!;
    const id = runtime.session.sessionManager.getSessionId();
    await runtime.dispose();
    const second = componentProducer();
    runtime = await f.start([second.factory], SessionManager.open(file));
    const recovery = taskRecoveryFromSession(runtime.session.sessionManager.getBranch(), id, runtime.session.sessionManager.getEntries());
    for (const frozen of recovery.results) await second.registry.restoreResult(frozen);
    await runtime.session.prompt("Stay on B below checkpoint", { source: "rpc" });
    assert.equal(JSON.stringify(f.requests.at(-1)).includes("FROZEN_CHECKPOINT_ANCESTOR_LEAK"), false);
    assert.equal(second.accepted, 0);
    assert.ok(recovery.held.length > 0);
    assert.equal(result.renders, 1);
  } finally { await runtime?.dispose(); f.cleanup(); }
});

test("a manually handed-off pending checkpoint ancestor cannot authorize sibling resume", async () => {
  const f = mcpFixture();
  const first = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([first.factory]);
    await runtime.session.prompt("Pending checkpoint origin", { source: "rpc" });
    const delivery = first.registry.capture();
    const old = deferred<any>();
    const reference = { endpointId: "checkpoint-endpoint", generation: "v2" as const, taskId: "checkpoint-pending", originalOperation: "tools/call" };
    const done = first.registry.start({ server: "demo", tool: "build", taskId: reference.taskId, delivery,
      execution: { settle: () => old.promise, cancel: async () => {}, result: async () => ({}), handoff: async (save: (value: typeof reference) => void) => {
        save(reference); old.resolve({ outcome: { status: "cancelled" } });
      } } as any,
      render: async () => ({ content: [], details: {} }), guard: async () => ({ content: [], details: {} }),
    });
    await first.registry.handOffForShutdown(); await done;
    const shared = runtime.session.sessionManager.appendCustomEntry("foreign-owner-checkpoint", { actor: "fixture" });
    await runtime.session.prompt("Original pending checkpoint path", { source: "rpc" });
    await runtime.session.navigateTree(shared, { summarize: false });
    await runtime.session.prompt("Sibling after pending checkpoint", { source: "rpc" });
    const file = runtime.session.sessionManager.getSessionFile()!;
    const id = runtime.session.sessionManager.getSessionId();
    await runtime.dispose();
    const second = componentProducer();
    runtime = await f.start([second.factory], SessionManager.open(file));
    const recovery = taskRecoveryFromSession(runtime.session.sessionManager.getBranch(), id, runtime.session.sessionManager.getEntries());
    let resumes = 0;
    for (const pending of recovery.pending) await second.registry.restore({ ...pending,
      render: async () => ({ content: [{ type: "text", text: "PENDING_CHECKPOINT_LEAK" }], details: {} }), guard: async () => ({ content: [], details: {} }),
    }, { taskSession: { resumeTask: async () => { resumes++; return { kind: "task", settle: async () => ({ outcome: { status: "completed", result: { content: [] } } }), cancel: async () => {} }; } } as any, closed: () => false });
    await runtime.session.prompt("Do not resume the old checkpoint on B", { source: "rpc" });
    assert.equal(resumes, 0);
    assert.ok(recovery.held.length > 0);
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes("PENDING_CHECKPOINT_LEAK"));
  } finally { await runtime?.dispose(); f.cleanup(); }
});

test("clean same-branch shutdown checkpoints all pending references after transport retirement and restores them without cancellation", async () => {
  const f = mcpFixture();
  const first = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([first.factory]);
    await runtime.session.prompt("Clean shutdown A", { source: "rpc" });
    let cancels = 0;
    const startPending = (id: string) => {
      const old = deferred<any>();
      const reference = { endpointId: "clean-endpoint", generation: "v2" as const, taskId: id, originalOperation: "tools/call" };
      return first.registry.start({ server: "demo", tool: "build", taskId: id, delivery: first.registry.capture(),
        execution: { settle: () => old.promise, cancel: async () => { cancels++; }, result: async () => ({}), handoff: async (save: (value: typeof reference) => void) => {
          save(reference); old.resolve({ outcome: { status: "cancelled" } });
        } } as any,
        render: async () => ({ content: [], details: {} }), guard: async () => ({ content: [], details: {} }),
      });
    };
    const one = startPending("clean-one");
    await runtime.session.prompt("Same branch C with no navigation", { source: "rpc" });
    const two = startPending("clean-two");
    const file = runtime.session.sessionManager.getSessionFile()!;
    const id = runtime.session.sessionManager.getSessionId();
    await runtime.dispose(); await Promise.all([one, two]);
    assert.equal(cancels, 0);
    const reopened = SessionManager.open(file);
    assert.equal((reopened.getLeafEntry() as any).data.kind, "checkpoint");
    const pending = pendingTasksFromBranch(reopened.getBranch(), id, reopened.getEntries());
    assert.equal(pending.length, 2, "one exact leaf checkpoint proves both references, not just the last appended handoff");
    assert.ok(pending.every(item => item.scope === "branch"));
    const second = componentProducer();
    runtime = await f.start([second.factory], reopened);
    let resumes = 0;
    await Promise.all(pending.map(item => second.registry.restore({ ...item,
      render: async () => ({ content: [{ type: "text", text: `RESTORED_${item.reference.taskId}` }], details: {} }), guard: async () => ({ content: [], details: {} }),
    }, { taskSession: { resumeTask: async () => { resumes++; return { kind: "task", settle: async () => ({ outcome: { status: "completed", result: { content: [] } } }), cancel: async () => {} }; } } as any, closed: () => false })));
    await runtime.session.prompt("Consume the two restored references", { source: "rpc" });
    assert.equal(resumes, 2);
    assert.equal(second.accepted, 2);
    assert.ok(JSON.stringify(f.requests.at(-1)).includes("RESTORED_clean-one"));
    assert.ok(JSON.stringify(f.requests.at(-1)).includes("RESTORED_clean-two"));
    assert.deepEqual(taskRecoveryFromSession(runtime.session.sessionManager.getBranch(), id, runtime.session.sessionManager.getEntries()).pending, []);
  } finally { await runtime?.dispose(); f.cleanup(); }
});

test("Task frozen on a sibling sharing its anchor cannot rehome after manager replacement", async () => {
  const f = mcpFixture();
  const first = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([first.factory]);
    await runtime.session.prompt("Shared ancestor A", { source: "rpc" });
    const anchor = runtime.session.sessionManager.getLeafId()!;
    const result = task(first, "shared-anchor", "TASK_SHARED_ANCESTOR_LEAK");
    await runtime.session.prompt("Original path past A", { source: "rpc" });
    await runtime.session.navigateTree(anchor, { summarize: false });
    await runtime.session.prompt("New sibling B under A", { source: "rpc" });
    result.finish(); await result.done;
    assert.equal(first.accepted, 0, "live generation correctly rejects the old sender on B");
    const file = runtime.session.sessionManager.getSessionFile()!;
    const sessionId = runtime.session.sessionManager.getSessionId();
    await runtime.dispose();
    const second = componentProducer();
    runtime = await f.start([second.factory], SessionManager.open(file));
    const recovery = taskRecoveryFromSession(runtime.session.sessionManager.getBranch(), sessionId, runtime.session.sessionManager.getEntries());
    assert.equal(recovery.held.length, 1, "the frozen outcome is retained and visibly classified as held");
    for (const frozen of recovery.results) await second.registry.restoreResult(frozen);
    await runtime.session.prompt("Stay on B; do not claim A's Task", { source: "rpc" });
    assert.equal(JSON.stringify(f.requests.at(-1)).includes("TASK_SHARED_ANCESTOR_LEAK"), false,
      "shared ancestor A is not authorization to rebind A's old Task to sibling B on recovery");
    assert.equal(second.accepted, 0);
    const sibling = runtime.session.sessionManager.getLeafId()!;
    await runtime.session.navigateTree(anchor, { summarize: false });
    const eligible = frozenTaskResultsFromBranch(runtime.session.sessionManager.getBranch(), sessionId, runtime.session.sessionManager.getEntries());
    assert.equal(eligible.length, 1, "returning to exact A finds the outcome even though its record lives off-branch on B");
    await second.registry.restoreResult(eligible[0]);
    await runtime.session.prompt("Resume A's held outcome", { source: "rpc" });
    await until(() => JSON.stringify(f.requests.at(-1)).includes("TASK_SHARED_ANCESTOR_LEAK"), "exact-origin frozen recovery");
    assert.equal(second.accepted, 1);
    assert.equal(result.renders, 1);
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 1);
    await runtime.session.waitForIdle();
    await until(() => runtime!.session.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1"
      && (entry.data as any).terminals?.some((item: any) => item.evidence?.key === result.delivery.deliveryId)), "Task fulfilled receipt before tree navigation");
    // A live SDK queue may still hold a submitted control even after fulfillment;
    // replacement is the public execution boundary that retires that old queue.
    const consumedFile = runtime.session.sessionManager.getSessionFile()!;
    await runtime.dispose();
    const third = componentProducer();
    runtime = await f.start([third.factory], SessionManager.open(consumedFile));
    const navigation = await runtime.session.navigateTree(sibling, { summarize: false });
    assert.equal(navigation.cancelled, false, "replacement retires the old control queue before sibling navigation");
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 0, "B excludes A's native result branch");
    runtime.session.sessionManager.appendCustomEntry("mcp-task-v1", taskCheckpointEntry(sessionId, {
      pending: [], results: [{ ...eligible[0], scope: "branch" }],
    }));
    const consumed = taskRecoveryFromSession(runtime.session.sessionManager.getBranch(), sessionId, runtime.session.sessionManager.getEntries());
    assert.deepEqual(consumed, { pending: [], results: [], held: [] }, "all-tree accepted identity wins even over a late exact-leaf checkpoint on B");
    await runtime.session.prompt("B cannot consume A's already accepted Task again", { source: "rpc" });
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes("TASK_SHARED_ANCESTOR_LEAK"), JSON.stringify(f.requests.at(-1)));
    assert.equal(second.accepted, 1);
    assert.equal(third.accepted, 0, "a late checkpoint cannot recreate accepted source ownership in the replacement");
  } finally { await runtime?.dispose(); f.cleanup(); }
});

test("pending Task handoff on a shared-ancestor sibling stays held across replacement and resumes only at exact origin", async () => {
  const f = mcpFixture();
  const first = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([first.factory]);
    await runtime.session.prompt("Pending origin A", { source: "rpc" });
    const anchor = runtime.session.sessionManager.getLeafId()!;
    const delivery = first.registry.capture();
    const old = deferred<any>();
    const reference = { endpointId: "lineage-endpoint", generation: "v2" as const, taskId: "pending", originalOperation: "tools/call" };
    const done = first.registry.start({ server: "demo", tool: "build", taskId: "pending", delivery,
      execution: { settle: () => old.promise, cancel: async () => {}, result: async () => ({}), handoff: async (save: (value: typeof reference) => void) => {
        save(reference); old.resolve({ outcome: { status: "cancelled" } });
      } } as any,
      render: async () => { throw new Error("a handed-off pending Task must not render before resume"); }, guard: async () => ({ content: [], details: {} }),
    });
    await runtime.session.prompt("Original pending path", { source: "rpc" });
    await runtime.session.navigateTree(anchor, { summarize: false });
    await runtime.session.prompt("Pending sibling B", { source: "rpc" });
    await first.registry.handOffForShutdown(); await done;
    const file = runtime.session.sessionManager.getSessionFile()!;
    const id = runtime.session.sessionManager.getSessionId();
    await runtime.dispose();
    const second = componentProducer();
    runtime = await f.start([second.factory], SessionManager.open(file));
    const blocked = taskRecoveryFromSession(runtime.session.sessionManager.getBranch(), id, runtime.session.sessionManager.getEntries());
    assert.equal(blocked.pending.length, 0);
    assert.equal(blocked.held.length, 1);
    await runtime.session.prompt("B cannot resume another branch's Task", { source: "rpc" });
    assert.equal(second.accepted, 0);
    await runtime.session.navigateTree(anchor, { summarize: false });
    const pending = pendingTasksFromBranch(runtime.session.sessionManager.getBranch(), id, runtime.session.sessionManager.getEntries());
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deliveryId, delivery.deliveryId);
    let resumes = 0;
    await second.registry.restore({ ...pending[0], render: async () => ({ content: [{ type: "text", text: "PENDING_ORIGIN_RESUMED" }], details: {} }), guard: async () => ({ content: [], details: {} }) }, {
      taskSession: { resumeTask: async (received: typeof reference) => {
        assert.deepEqual(received, reference); resumes++;
        return { kind: "task", settle: async () => ({ outcome: { status: "completed", result: { content: [] } } }), cancel: async () => {} };
      } } as any, closed: () => false,
    });
    await runtime.session.prompt("Consume A's resumed Task", { source: "rpc" });
    assert.equal(resumes, 1);
    assert.equal(second.accepted, 1);
    assert.ok(JSON.stringify(f.requests.at(-1)).includes("PENDING_ORIGIN_RESUMED"));
  } finally { await runtime?.dispose(); f.cleanup(); }
});

test("full factory lazy startup discovers off-branch held Task records and recovers only on original leaf through public TUI binding", async () => {
  const f = mcpFixture();
  const server = await appServer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    const manager = SessionManager.create(f.root, join(f.root, "sessions"));
    manager.appendMessage({ role: "user", content: "Original A", timestamp: Date.now() });
    const anchor = manager.appendMessage(fauxAssistantMessage("A"));
    manager.appendMessage({ role: "user", content: "Sibling B", timestamp: Date.now() });
    manager.appendMessage(fauxAssistantMessage("B"));
    const deliveryId = `task:${manager.getSessionId()}:held-factory`;
    manager.appendCustomEntry("mcp-task-v1", frozenTaskResultEntry(manager.getSessionId(), {
      key: "demo/held-factory", server: "demo", tool: "app", deliveryId, anchorEntryId: anchor, scope: "origin-leaf",
      message: { customType: "mcp-task-result", display: true, content: [{ type: "text", text: "FULL_FACTORY_HELD_TASK" }],
        details: { server: "demo", deliveryId, task: { id: "held-factory", server: "demo", tool: "app", status: "completed" } } },
    }));
    const notices: string[] = [];
    const ui = {
      theme: { fg: (_color: string, value: string) => value },
      notify: (message: string) => notices.push(message),
      setStatus() {}, setWidget() {}, setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {},
      setTitle() {}, setEditorText() {}, getEditorText: () => "", onTerminalInput: () => () => {},
      select: async () => undefined, confirm: async () => false, input: async () => undefined,
    } as unknown as ExtensionUIContext;
    const factory = createMcpAdapter({ config: { mcpServers: { demo: { url: server.url, lifecycle: "lazy", directTools: false } },
      settings: { deferWithMissingMetadata: true, directTools: false, namespaceProxyTools: false, sampling: false, elicitation: false } } });
    runtime = await f.start([factory], manager, ui);
    await until(() => notices.some(message => /task result\/reference.*held/.test(message)), "full factory held Task startup notice");
    assert.equal(f.requests.length, 0);
    await runtime.session.prompt("B must not receive A's result", { source: "rpc" });
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes("FULL_FACTORY_HELD_TASK"));
    await runtime.session.navigateTree(anchor, { summarize: false });
    await runtime.session.prompt("Resume original A", { source: "rpc", streamingBehavior: "followUp" });
    await until(() => f.requests.some(messages => JSON.stringify(messages).includes("FULL_FACTORY_HELD_TASK")), "full factory exact-origin Task recovery");
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 1);
    assert.equal(server.calls.filter(method => method === "tools/call").length, 0, "factory recovery does not replay the completed remote tool");
    assert.deepEqual(f.errors, []);
  } finally { await runtime?.dispose(); await server.close(); f.cleanup(); }
});

test("Task pre-request capture is fenced by real session_tree navigation; returning to the exact origin retries same delivery", async () => {
  const f = mcpFixture();
  const source = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([source.factory]);
    await runtime.session.prompt("Original branch root", { source: "rpc" });
    const root = runtime.session.sessionManager.getLeafId()!;
    await runtime.session.prompt("Original Task origin", { source: "rpc" });
    const origin = runtime.session.sessionManager.getLeafId()!;
    const result = task(source, "fenced", "TASK_ORIGINAL_BRANCH_ONLY");
    await runtime.session.navigateTree(root, { summarize: false });
    result.finish(); await result.done;
    assert.equal(source.accepted, 0, "the old target cannot accept on a sibling even if some ancestors are shared");
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 0);
    const baseline = f.requests.length;
    await runtime.session.navigateTree(origin, { summarize: false });
    await source.registry.handOffForShutdown();
    assert.equal(source.accepted, 1);
    await until(() => f.requests.slice(baseline).some(messages => JSON.stringify(messages).includes("TASK_ORIGINAL_BRANCH_ONLY")), "origin-only Task delivery");
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-task-result").length, 1);
    assert.equal(result.renders, 1);
    assertDurableFile(runtime.session.sessionManager, result.delivery.deliveryId);
    assert.deepEqual(f.errors, []);
  } finally { await runtime?.dispose(); f.cleanup(); }
});
