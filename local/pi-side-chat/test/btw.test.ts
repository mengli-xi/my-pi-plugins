import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BTW_ANSWERED_TOAST,
  BTW_BOUNDARY_PROMPT,
  BTW_TOAST_KEY,
  BtwController,
  type BtwAnswer,
  type BtwBrowserUpdates,
  type BtwEntry,
  type BtwReadState,
} from "../btw.ts";
import { BtwBrowser } from "../btw-browser.ts";
import type { MainContextSnapshot } from "../effective-context.ts";
import type { BtwStatusSurface } from "../statusline.ts";

const usage = {
  input: 10,
  output: 3,
  cacheRead: 90,
  cacheWrite: 0,
  totalTokens: 103,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "model",
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

function snapshot(): MainContextSnapshot {
  return {
    messages: [{ role: "user", content: "parent context", timestamp: 0 }],
    baseSystemPrompt: "base",
    systemPrompt: "system",
    systemPromptOptions: { cwd: "/tmp", skills: [] },
    cacheLineageId: "parent-session",
    exactPrefix: true,
  };
}

function context(complete: (...args: any[]) => Promise<AssistantMessage>) {
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const widgets: Array<{ key: string; mounted: boolean; placement?: string }> = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: { provider: "test", id: "model", api: "openai-responses" },
    thinkingLevel: "medium",
    modelRegistry: { complete },
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string) => notices.push(message),
      setWidget: (key: string, factory: unknown, options?: { placement?: string }) => {
        widgets.push({ key, mounted: factory !== undefined, placement: options?.placement });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses, notices, widgets };
}

/** Records the order in which the controller published and withdrew its status. */
function statusRecorder() {
  const events: string[] = [];
  const value: BtwStatusSurface = {
    show: () => { events.push("show"); },
    clear: () => { events.push("clear"); },
  };
  return { events, value };
}

/**
 * Records what the controller announced, opened, and released.
 *
 * With `hold`, `showBrowser` stays pending the way the real panel does until the
 * test closes it, which is what makes the browser count as open.
 */
function presenter(options: { hold?: boolean } = {}) {
  const shown: BtwAnswer[] = [];
  const histories: Array<readonly BtwEntry[]> = [];
  const sources: Array<() => readonly BtwEntry[]> = [];
  const updates: BtwBrowserUpdates[] = [];
  const reads: BtwReadState[] = [];
  const disposals: number[] = [];
  let closeBrowser: (() => void) | undefined;
  return {
    shown,
    histories,
    sources,
    updates,
    reads,
    disposals,
    /** Close whatever browser this presenter is holding open. */
    close(): void {
      const done = closeBrowser;
      closeBrowser = undefined;
      done?.();
    },
    value: {
      async notifyAnswered(_ctx: ExtensionContext, answer: BtwAnswer) { shown.push(answer); },
      async showBrowser(
        _ctx: ExtensionContext,
        history: () => readonly BtwEntry[],
        read: BtwReadState,
        changes: BtwBrowserUpdates,
      ) {
        updates.push(changes);
        sources.push(history);
        reads.push(read);
        histories.push(history().map((answer) => structuredClone(answer)));
        if (!options.hold) return;
        await new Promise<void>((resolve) => { closeBrowser = resolve; });
      },
      dispose() { disposals.push(disposals.length + 1); },
    },
  };
}

/** The questions a browser opened right now would draw an unread mark beside. */
function unread(controller: BtwController): string[] {
  const read = controller.readState();
  return controller.answers()
    .filter((answer) => !read.isRead(answer))
    .map((answer) => answer.question);
}

test("the completion primitive sends one tool-free request with an independent request id and parent cache lineage", async () => {
  let capturedContext: Record<string, unknown> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  const { ctx, statuses } = context(async (_model, requestContext, options) => {
    capturedContext = requestContext;
    capturedOptions = options;
    const payload = await options.onPayload({ prompt_cache_key: "btw-request" });
    assert.deepEqual(payload, { prompt_cache_key: "parent-session" });
    return response("one-off answer");
  });
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  const original = snapshot();
  const answer = await controller.run("why?", ctx, () => original);

  assert.equal(answer?.answer, "one-off answer");
  assert.deepEqual(capturedContext?.tools, []);
  const messages = capturedContext?.messages as Array<{ role?: string; content?: unknown }>;
  assert.equal(messages.at(-1)?.role, "user");
  assert.equal(String(messages.at(-1)?.content).startsWith(BTW_BOUNDARY_PROMPT), true);
  assert.notEqual(capturedOptions?.sessionId, "parent-session");
  assert.equal(capturedOptions?.maxTokens, 2_048);
  assert.deepEqual(original.messages, [{ role: "user", content: "parent context", timestamp: 0 }]);
  assert.deepEqual(statuses, ["BTW… · /btw cancel", undefined]);
  assert.equal(view.shown.length, 1, "one completion notice");
  assert.equal(view.histories.length, 0, "run only completes; the command's start entry point opens the live panel");
});

test("BTW rejects a second concurrent request and session shutdown aborts only BTW", async () => {
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const waiting = new Promise<AssistantMessage>((resolve) => { release = () => resolve(response("late")); });
  const { ctx } = context(async (_model, _requestContext, options) => {
    signal = options.signal;
    return waiting;
  });
  const controller = new BtwController(presenter().value);
  controller.startSession();
  const first = controller.run("first", ctx, snapshot);
  await Promise.resolve();
  await assert.rejects(controller.run("second", ctx, snapshot), /already running/u);
  assert.equal(controller.cancel(), true);
  assert.equal(controller.cancel(), false);
  assert.equal(signal?.aborted, true);
  release();
  assert.equal(await first, undefined);
  assert.deepEqual(controller.answers(), []);
});

test("session replacement clears the owned BTW status", async () => {
  let release!: () => void;
  const waiting = new Promise<AssistantMessage>((resolve) => { release = () => resolve(response("late")); });
  const { ctx, statuses } = context(async () => waiting);
  const controller = new BtwController(presenter().value);
  controller.startSession();
  const request = controller.run("pending", ctx, snapshot);
  await Promise.resolve();
  controller.startSession();
  assert.deepEqual(statuses, ["BTW… · /btw cancel", undefined]);
  release();
  assert.equal(await request, undefined);
});

test("a started BTW returns to its caller and stays cancellable while the model runs", async () => {
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const waiting = new Promise<AssistantMessage>((resolve) => { release = () => resolve(response("late")); });
  const { ctx, statuses } = context(async (_model, _requestContext, options) => {
    signal = options.signal;
    return waiting;
  });
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  const errors: string[] = [];
  const first = controller.start("first", ctx, snapshot, (error) => errors.push(String(error)));

  assert.equal(controller.cancel(), true);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(statuses, ["BTW… · /btw cancel", undefined]);
  release();
  await first;
  assert.equal(errors.length, 0, `unexpected BTW error: ${errors[0]}`);
  assert.equal(view.shown.length, 0, "a cancelled request must not announce a completion");
  assert.deepEqual(controller.answers(), []);

  const { ctx: nextCtx } = context(async () => response("second answer"));
  await controller.start("second", nextCtx, snapshot, (error) => errors.push(String(error)));
  assert.equal(errors.length, 0, `unexpected BTW error: ${errors[0]}`);
  assert.deepEqual(controller.answers().map((answer) => answer.answer), ["second answer"]);
});

test("a started BTW reports duplicate and missing-model failures through the reporter", async () => {
  let release!: () => void;
  const waiting = new Promise<AssistantMessage>((resolve) => { release = () => resolve(response("late")); });
  const { ctx } = context(async () => waiting);
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  const errors: string[] = [];
  const report = (error: unknown) => errors.push(error instanceof Error ? error.message : String(error));
  const first = controller.start("first", ctx, snapshot, report);
  const duplicate = controller.start("second", ctx, snapshot, report);
  await duplicate;
  assert.deepEqual(errors, ["A BTW question is already running"]);

  release();
  await first;
  assert.equal(view.shown.length, 1, "the duplicate must not cancel the running request");

  const { ctx: modelless } = context(async () => response("never"));
  (modelless as { model?: unknown }).model = undefined;
  await controller.start("third", modelless, snapshot, report);
  assert.deepEqual(errors, ["A BTW question is already running", "BTW requires an active model"]);
});

test("session replacement drops a started BTW answer instead of showing it late", async () => {
  let release!: () => void;
  const waiting = new Promise<AssistantMessage>((resolve) => { release = () => resolve(response("late")); });
  const { ctx } = context(async () => waiting);
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  const errors: string[] = [];
  const pending = controller.start("pending", ctx, snapshot, (error) => errors.push(String(error)));
  controller.shutdown();
  release();
  await pending;

  assert.equal(errors.length, 0, `unexpected BTW error: ${errors[0]}`);
  assert.equal(view.shown.length, 0);
  assert.deepEqual(controller.answers(), []);
});

test("BTW without a question opens the in-memory browser and never creates a follow-up context", async () => {
  let calls = 0;
  const { ctx } = context(async () => { calls++; return response(`answer ${calls}`); });
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  await controller.run("first", ctx, snapshot);
  await controller.run("second", ctx, snapshot);
  await controller.run("", ctx, snapshot);

  assert.equal(calls, 2);
  assert.deepEqual(controller.answers().map((answer) => answer.question), ["first", "second"]);
  assert.equal(view.histories.length, 1);
  assert.deepEqual(view.histories[0]?.map((answer) => answer.question), ["first", "second"]);
});

/** Holds one completion per question until the test releases it by name. */
function heldProvider() {
  const releases = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const complete = async (_model: unknown, requestContext: any, options: any) => {
    const asked = String(requestContext.messages.at(-1)?.content);
    const name = asked.includes("first") ? "first" : "second";
    signals.set(name, options.signal);
    return new Promise<AssistantMessage>((resolve) => {
      releases.set(name, () => resolve(response(`${name} answer`)));
    });
  };
  return {
    complete,
    signals,
    release: (name: string) => releases.get(name)!(),
  };
}

test("a cancelled BTW that settles late leaves its replacement running and unanswered", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  const errors: string[] = [];
  const report = (error: unknown) => errors.push(error instanceof Error ? error.message : String(error));

  const first = controller.start("first", ctx, snapshot, report);
  assert.equal(controller.cancel(), true);

  let secondDone = false;
  const second = controller.start("second", ctx, snapshot, report)
    .then(() => { secondDone = true; });
  assert.deepEqual(errors, [], "a question sent right after a cancel must not be refused as a duplicate");

  provider.release("first");
  await first;
  await Promise.resolve();

  assert.equal(secondDone, false, "the cancelled request must not settle the one that replaced it");
  assert.equal(provider.signals.get("second")?.aborted, false, "the late request must not abort its replacement");
  assert.equal(view.shown.length, 0, "a cancelled request must not announce a late answer");
  assert.deepEqual(controller.answers(), []);

  provider.release("second");
  await second;
  assert.deepEqual(view.shown.map((answer) => answer.answer), ["second answer"]);
  assert.deepEqual(controller.answers().map((answer) => answer.question), ["second"]);
  assert.equal(controller.cancel(), false, "no request stays active once the answer arrived");
});

test("cancel after a late-settling predecessor aborts the running question, not the drained one", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  const first = controller.start("first", ctx, snapshot, () => undefined);
  assert.equal(controller.cancel(), true);
  const second = controller.start("second", ctx, snapshot, () => undefined);

  provider.release("first");
  await first;

  assert.equal(controller.cancel(), true, "the replacement is still the cancellable request");
  assert.equal(provider.signals.get("second")?.aborted, true);
  provider.release("second");
  await second;
  assert.equal(view.shown.length, 0);
  assert.deepEqual(controller.answers(), []);
});

test("BTW publishes one pending status per request and the drained one withdraws nothing", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const status = statusRecorder();
  const view = presenter();
  const controller = new BtwController(view.value, status.value);
  controller.startSession();

  const first = controller.start("first", ctx, snapshot, () => undefined);
  assert.deepEqual(status.events, ["show"]);
  assert.equal(controller.cancel(), true);
  assert.deepEqual(status.events, ["show", "clear"]);

  const second = controller.start("second", ctx, snapshot, () => undefined);
  assert.deepEqual(status.events, ["show", "clear", "show"]);
  provider.release("first");
  await first;
  assert.deepEqual(status.events, ["show", "clear", "show"],
    "a drained request must not withdraw the replacement's status");

  provider.release("second");
  await second;
  assert.deepEqual(status.events, ["show", "clear", "show", "clear"]);
});

test("session shutdown withdraws the pending status it owns", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const status = statusRecorder();
  const controller = new BtwController(presenter().value, status.value);
  controller.startSession();
  const first = controller.start("first", ctx, snapshot, () => undefined);
  assert.deepEqual(status.events, ["show"]);
  controller.shutdown();
  assert.deepEqual(status.events, ["show", "clear"]);
  provider.release("first");
  await first;
  assert.deepEqual(status.events, ["show", "clear"]);
});

test("the pending status goes down when the answer arrives, not when its notice ends", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter({ hold: true });
  const status = statusRecorder();
  let endNotice!: () => void;
  const noticeShown = new Promise<void>((resolve) => { endNotice = resolve; });
  const shown: BtwAnswer[] = [];
  const controller = new BtwController({
    ...view.value,
    async notifyAnswered(_ctx: ExtensionContext, answer: BtwAnswer) {
      shown.push(answer);
      await noticeShown;
    },
  }, status.value);
  controller.startSession();

  const task = controller.start("first", ctx, snapshot, () => undefined);
  assert.equal(controller.browserIsOpen(), true, "submission opened the pending panel");
  view.close();
  await settled();
  assert.equal(controller.browserIsOpen(), false, "the user dismissed the pending panel");
  assert.deepEqual(status.events, ["show"], "dismissal does not stop the request");
  provider.release("first");
  await settled();
  assert.equal(shown.length, 1, "the completion notice is up");
  assert.deepEqual(status.events, ["show", "clear"], "an answered question no longer reports as pending");
  assert.equal(controller.cancel(), false, "an answer already delivered is not cancellable");

  endNotice();
  await task;
  assert.deepEqual(status.events, ["show", "clear"]);
  assert.deepEqual(controller.answers().map((answer) => answer.answer), ["first answer"]);
});

/** Let every already-scheduled continuation run before asserting. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A Side handoff Main is waiting on, released by the test. */
function terminalGate() {
  let occupied: Promise<void> | undefined;
  let release: (() => void) | undefined;
  return {
    take(): void {
      occupied = new Promise<void>((resolve) => { release = resolve; });
    },
    give(): void {
      const resolve = release;
      occupied = undefined;
      release = undefined;
      resolve?.();
    },
    value: { occupied: () => occupied },
  };
}

test("an answer that arrives during a Side handoff is announced after Main is back", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter();
  const gate = terminalGate();
  const controller = new BtwController(view.value, undefined, gate.value);
  controller.startSession();

  const question = controller.start("first", ctx, snapshot, () => undefined);
  gate.take();
  provider.release("first");
  await settled();
  assert.equal(view.shown.length, 0, "no notice may be posted while Side owns the terminal");
  assert.equal(controller.heldAnswer()?.answer, "first answer");
  assert.deepEqual(controller.answers().map((answer) => answer.question), ["first"],
    "the answer is recorded when it arrives, not when it is announced");
  assert.equal(controller.cancel(), false, "a held answer is no longer a running request");

  gate.give();
  await question;
  assert.deepEqual(view.shown.map((answer) => answer.answer), ["first answer"]);
  assert.equal(controller.heldAnswer(), undefined);
});

test("a second handoff keeps the held notice waiting until Main owns the terminal", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter();
  const gate = terminalGate();
  const controller = new BtwController(view.value, undefined, gate.value);
  controller.startSession();

  const question = controller.start("first", ctx, snapshot, () => undefined);
  gate.take();
  provider.release("first");
  await settled();

  const first = gate.value.occupied();
  gate.give();
  gate.take();
  await first;
  await settled();
  assert.equal(view.shown.length, 0, "a handoff that starts again must hold the notice back");
  assert.equal(controller.heldAnswer()?.answer, "first answer");

  gate.give();
  await question;
  assert.deepEqual(view.shown.map((answer) => answer.answer), ["first answer"]);
});

test("session replacement drops an answer held behind a Side handoff", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter();
  const gate = terminalGate();
  const controller = new BtwController(view.value, undefined, gate.value);
  controller.startSession();

  const question = controller.start("first", ctx, snapshot, () => undefined);
  gate.take();
  provider.release("first");
  await settled();
  assert.equal(controller.heldAnswer()?.answer, "first answer");

  controller.startSession();
  await question;
  assert.equal(view.shown.length, 0, "a replaced session must not announce the old answer");
  assert.equal(controller.heldAnswer(), undefined);
  assert.deepEqual(controller.answers(), []);

  gate.give();
  await settled();
  assert.equal(view.shown.length, 0, "releasing the terminal later must not revive the answer");
});

test("the default presenter posts one BTW completion toast above the editor", async () => {
  const { ctx, widgets, notices } = context(async () => response("answered"));
  const controller = new BtwController();
  controller.startSession();
  await controller.run("question", ctx, snapshot);

  assert.deepEqual(widgets, [{ key: BTW_TOAST_KEY, mounted: true, placement: "aboveEditor" }]);
  assert.deepEqual(notices, [], "the notice replaces the old answer panel, it does not notify");

  // The toast belongs to this runtime: a replaced session takes it down.
  controller.startSession();
  assert.deepEqual(widgets.at(-1), { key: BTW_TOAST_KEY, mounted: false, placement: "aboveEditor" });
});

test("the completion toast renders BTW's own wording once, centred above the editor", async () => {
  const mounted: Array<{ render(width: number): string[] }> = [];
  const { ctx } = context(async () => response("answered"));
  (ctx as unknown as { ui: { setWidget(key: string, factory: unknown): void } }).ui.setWidget =
    (_key, factory) => {
      if (typeof factory === "function") {
        mounted.push((factory as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
          {},
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        ));
      }
    };
  const controller = new BtwController();
  controller.startSession();
  await controller.run("question", ctx, snapshot);

  assert.equal(mounted.length, 1);
  const line = mounted[0]!.render(60).join("");
  assert.equal(line.includes(BTW_ANSWERED_TOAST), true);
  assert.equal(line.includes("answered"), true);
  assert.equal(line.length <= 60 + 8, true, "the toast stays inside the editor width");
});

test("session replacement releases the completion notice the runtime owns", async () => {
  const { ctx } = context(async () => response("answered"));
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  await controller.run("question", ctx, snapshot);
  assert.deepEqual(view.disposals, [1], "startSession released the previous runtime's notice");

  controller.shutdown();
  assert.deepEqual(view.disposals, [1, 2]);
});

test("a browser opened over the live history sees answers that land after it opened", async () => {
  let calls = 0;
  const { ctx } = context(async () => { calls++; return response(`answer ${calls}`); });
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  await controller.run("first", ctx, snapshot);
  await controller.run("", ctx, snapshot);
  assert.deepEqual(view.histories[0]?.map((answer) => answer.question), ["first"]);

  await controller.run("second", ctx, snapshot);
  assert.deepEqual(view.sources[0]?.().map((answer) => answer.question), ["first", "second"],
    "the open browser reads the same history the controller keeps appending to");

  // A replaced session empties it rather than leaving the old answers reachable.
  controller.startSession();
  assert.deepEqual(view.sources[0]?.(), []);
});

test("an answer that finishes with the browser open posts no toast and joins it unread", async () => {
  let release!: () => void;
  const late = new Promise<AssistantMessage>((resolve) => {
    release = () => resolve(response("second answer"));
  });
  let calls = 0;
  const { ctx } = context(async () => (++calls === 1 ? response("first answer") : late));
  const view = presenter({ hold: true });
  const controller = new BtwController(view.value);
  controller.startSession();

  await controller.run("first", ctx, snapshot);
  assert.equal(view.shown.length, 1, "with nothing open, a finished question is announced");

  const browsing = controller.showBrowser(ctx);
  await settled();
  assert.equal(controller.browserIsOpen(), true);
  // The browser drew the answer it opened on, and reports that back.
  const read = view.reads[0]!;
  read.markRead(controller.answers()[0]!);
  assert.deepEqual(unread(controller), []);

  const second = controller.start("second", ctx, snapshot, () => undefined);
  release();
  await second;

  assert.equal(view.shown.length, 1, "an answer that lands behind the browser posts no notice");
  assert.equal(view.sources.length, 1, "and stacks no second browser");
  assert.deepEqual(controller.answers().map((answer) => answer.question), ["first", "second"]);
  assert.deepEqual(unread(controller), ["second"], "the list's unread mark is the whole notice");

  view.close();
  await browsing;
  assert.equal(controller.browserIsOpen(), false);
  assert.equal(view.shown.length, 1, "closing the browser does not post the notice late");

  // With the browser gone, the next answer is announced the usual way.
  await controller.run("third", ctx, snapshot);
  assert.deepEqual(view.shown.map((answer) => answer.question), ["first", "third"]);
});

test("an answer held behind a Side handoff is still announced when no browser is open", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter();
  const gate = terminalGate();
  const controller = new BtwController(view.value, undefined, gate.value);
  controller.startSession();

  const question = controller.start("first", ctx, snapshot, () => undefined);
  gate.take();
  provider.release("first");
  await settled();
  assert.equal(view.shown.length, 0, "the gate still holds the notice back");

  gate.give();
  await question;
  assert.deepEqual(view.shown.map((answer) => answer.answer), ["first answer"]);
  assert.deepEqual(unread(controller), ["first"], "an announced answer is not a read one");
});

test("read state survives closing and reopening the browser, and dies with the session", async () => {
  let calls = 0;
  const { ctx } = context(async () => { calls++; return response(`answer ${calls}`); });
  const view = presenter({ hold: true });
  const controller = new BtwController(view.value);
  controller.startSession();
  await controller.run("first", ctx, snapshot);
  await controller.run("second", ctx, snapshot);

  const first = controller.showBrowser(ctx);
  await settled();
  view.reads[0]!.markRead(controller.answers()[1]!);
  view.close();
  await first;
  assert.deepEqual(unread(controller), ["first"]);

  const again = controller.showBrowser(ctx);
  await settled();
  assert.equal(view.reads[1]!.isRead(controller.answers()[1]!), true,
    "a browser opened again reads the same state, not a fresh one");
  view.close();
  await again;

  controller.startSession();
  await controller.run("third", ctx, snapshot);
  assert.deepEqual(unread(controller), ["third"], "a replaced session starts with nothing read");
});

test("the twentieth eviction drops the evicted answer's read state with it", async () => {
  let calls = 0;
  const { ctx } = context(async () => { calls++; return response(`answer ${calls}`); });
  const controller = new BtwController(presenter().value);
  controller.startSession();
  for (let index = 1; index <= 20; index++) await controller.run(`question ${index}`, ctx, snapshot);

  const oldest = controller.answers()[0]!;
  for (const answer of controller.answers()) controller.readState().markRead(answer);
  assert.deepEqual(unread(controller), []);

  await controller.run("question 21", ctx, snapshot);
  assert.equal(controller.answers().some((answer) => answer.question === "question 1"), false);
  assert.equal(controller.readState().isRead(oldest), false,
    "the dropped answer took its read state with it, so its key cannot be reused");
  assert.deepEqual(unread(controller), ["question 21"], "and the newest answer arrives unread");
});

test("a provider failure closes the pending panel before reporting the error", async () => {
  let reject!: (error: Error) => void;
  const { ctx } = context(() => new Promise<AssistantMessage>((_resolve, fail) => { reject = fail; }));
  const view = presenter({ hold: true });
  const status = statusRecorder();
  const controller = new BtwController(view.value, status.value);
  const reports: Array<{ error: unknown; closed: boolean }> = [];
  controller.startSession();
  const task = controller.start("failed question", ctx, snapshot, error => {
    reports.push({ error, closed: view.updates[0]!.signal.aborted });
  });
  assert.equal(view.updates.length, 1);
  reject(new Error("provider down"));
  await task;
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.closed, true, "the Main error must not be hidden behind a stale panel");
  assert.match(String(reports[0]!.error), /provider down/);
  assert.deepEqual(controller.answers(), []);
  assert.deepEqual(status.events, ["show", "clear"]);
  assert.equal(view.shown.length, 0);
  view.close();
  await settled();
});

test("a cancelled or failed request leaves nothing in the list to mark unread", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  const errors: string[] = [];
  const report = (error: unknown) => errors.push(error instanceof Error ? error.message : String(error));

  const cancelled = controller.start("first", ctx, snapshot, report);
  assert.equal(controller.cancel(), true);
  provider.release("first");
  await cancelled;
  assert.deepEqual(unread(controller), []);

  const { ctx: failing } = context(async () => { throw new Error("provider down"); });
  await controller.start("second", failing, snapshot, report);
  assert.deepEqual(errors, ["provider down"]);
  assert.deepEqual(controller.answers(), []);
  assert.deepEqual(unread(controller), [], "a failed question is not an unread answer");
  assert.equal(view.shown.length, 0);
});

test("BTW keeps only the newest twenty answers, newest last in history order", async () => {
  let calls = 0;
  const { ctx } = context(async () => { calls++; return response(`answer ${calls}`); });
  const view = presenter();
  const controller = new BtwController(view.value);
  controller.startSession();
  for (let index = 1; index <= 20; index++) await controller.run(`question ${index}`, ctx, snapshot);
  const last = controller.start("question 21", ctx, snapshot, () => undefined);
  assert.equal(view.histories[0]?.length, 21, "pending does not evict any of the twenty completed answers");
  assert.equal(view.histories[0]?.[0]?.question, "question 1");
  assert.equal(view.histories[0]?.at(-1)?.question, "question 21");
  await last;

  const questions = controller.answers().map((answer) => answer.question);
  assert.equal(questions.length, 20);
  assert.equal(questions[0], "question 2", "the oldest answer is dropped");
  assert.equal(questions.at(-1), "question 21");
});

test("submission opens a pending panel immediately and replaces the same entry without a second panel", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter({ hold: true });
  const controller = new BtwController(view.value);
  const errors: unknown[] = [];
  const task = controller.start("first", ctx, snapshot, error => { errors.push(error); });
  assert.equal(controller.browserIsOpen(), true);
  assert.equal(view.sources.length, 1);
  const pending = view.sources[0]!()[0]!;
  assert.equal("state" in pending && pending.state, "pending");
  assert.equal(pending.question, "first");
  assert.deepEqual(controller.answers(), [], "pending is not a finished answer");
  let changes = 0;
  const unsubscribe = view.updates[0]!.subscribe(() => { changes++; });

  provider.release("first");
  await task;
  const final = view.sources[0]!()[0]!;
  assert.equal(final.createdAt, pending.createdAt, "replacement keeps the selection identity");
  assert.equal("answer" in final && final.answer, "first answer");
  assert.equal(changes, 1, "completion requests an in-place render");
  assert.equal(view.sources.length, 1, "completion must not stack another panel");
  assert.equal(view.shown.length, 0, "no toast behind the live panel");
  assert.deepEqual(errors, []);
  unsubscribe();
  view.close();
  await settled();
});

test("closing the pending panel leaves Main available and completion never reopens it", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter({ hold: true });
  const controller = new BtwController(view.value);
  const task = controller.start("first", ctx, snapshot, () => undefined);
  view.close();
  await settled();
  assert.equal(controller.browserIsOpen(), false);
  assert.equal(provider.signals.get("first")?.aborted, false, "closing does not cancel the request");
  provider.release("first");
  await task;
  assert.equal(view.sources.length, 1, "the closed interaction stays closed");
  assert.deepEqual(view.shown.map(answer => answer.answer), ["first answer"]);
});

test("Side holds the submission panel until Main returns, including a second handoff", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter({ hold: true });
  const gate = terminalGate();
  gate.take();
  const controller = new BtwController(view.value, undefined, gate.value);
  const task = controller.start("first", ctx, snapshot, () => undefined);
  assert.equal(view.sources.length, 0, "submission cannot steal Side's terminal");
  gate.give();
  gate.take();
  await settled();
  assert.equal(view.sources.length, 0, "the gate is rechecked after a handoff ends");
  gate.give();
  await settled();
  assert.equal(view.sources.length, 1);
  assert.equal("state" in view.sources[0]!()[0]!, true, "Main sees pending before completion");
  provider.release("first");
  await task;
  assert.equal(view.shown.length, 0);
  view.close();
  await settled();
});

test("a question completed behind Side opens the final panel only when Main returns", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter({ hold: true });
  const gate = terminalGate();
  gate.take();
  const controller = new BtwController(view.value, undefined, gate.value);
  const task = controller.start("first", ctx, snapshot, () => undefined);
  provider.release("first");
  await settled();
  assert.equal(view.sources.length, 0);
  assert.deepEqual(controller.answers().map(answer => answer.answer), ["first answer"]);
  assert.equal(controller.cancel(), false, "the provider already completed");
  gate.give();
  await task;
  assert.equal(view.sources.length, 1);
  assert.equal("answer" in view.sources[0]!()[0]!, true);
  assert.equal(view.shown.length, 0, "the deferred panel replaces the completion notice");
  view.close();
  await settled();
});

test("a replacement submitted immediately after cancel owns the queued panel", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter({ hold: true });
  const gate = terminalGate();
  gate.take();
  const controller = new BtwController(view.value, undefined, gate.value);
  const first = controller.start("first", ctx, snapshot, () => undefined);
  controller.cancel();
  const second = controller.start("second", ctx, snapshot, () => undefined);
  gate.give();
  await settled();
  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0]!()[0]?.question, "second");
  provider.release("first");
  await first;
  assert.equal("state" in view.sources[0]!()[0]!, true, "the drained predecessor leaves replacement pending");
  provider.release("second");
  await second;
  assert.equal("answer" in view.sources[0]!()[0]!, true);
  view.close();
  await settled();
});

test("cancelling or replacing a generation drops its queued panel before Side returns", async () => {
  for (const end of ["cancel", "shutdown"] as const) {
    const provider = heldProvider();
    const { ctx } = context(provider.complete);
    const view = presenter({ hold: true });
    const gate = terminalGate();
    gate.take();
    const controller = new BtwController(view.value, undefined, gate.value);
    const task = controller.start("first", ctx, snapshot, () => undefined);
    if (end === "cancel") assert.equal(controller.cancel(), true);
    else controller.shutdown();
    gate.give();
    provider.release("first");
    await task;
    await settled();
    assert.equal(view.sources.length, 0, `${end} must not open the abandoned panel`);
    assert.deepEqual(controller.answers(), []);
  }
});

test("cancel removes pending from an open panel and shutdown closes its interaction", async () => {
  const provider = heldProvider();
  const { ctx } = context(provider.complete);
  const view = presenter({ hold: true });
  const controller = new BtwController(view.value);
  const task = controller.start("first", ctx, snapshot, () => undefined);
  let changes = 0;
  const unsubscribe = view.updates[0]!.subscribe(() => { changes++; });
  assert.equal(controller.cancel(), true);
  assert.deepEqual(view.sources[0]!(), []);
  assert.equal(changes, 1);
  controller.shutdown();
  assert.equal(view.updates[0]!.signal.aborted, true, "the old panel receives a lifecycle close signal");
  assert.equal(controller.browserIsOpen(), false);
  provider.release("first");
  await task;
  unsubscribe();
  view.close();
  await settled();
});

test("cancelling pending at the history limit preserves the oldest answer's selection and scroll", async () => {
  const longAnswer = Array.from({ length: 80 }, (_, index) => `answer line ${index}`).join("\n");
  let calls = 0;
  let release!: () => void;
  const { ctx } = context(async () => {
    if (++calls <= 20) return response(longAnswer);
    return new Promise<AssistantMessage>(resolve => { release = () => resolve(response("cancelled answer")); });
  });
  const view = presenter({ hold: true });
  const controller = new BtwController(view.value);
  for (let index = 1; index <= 20; index++) await controller.run(`question ${index}`, ctx, snapshot);
  const browsing = controller.showBrowser(ctx);
  const browser = new BtwBrowser({ theme: ctx.ui.theme, history: view.sources[0]!, read: view.reads[0]! });
  browser.renderBody(120, 8);
  browser.handleKey("G");
  browser.renderBody(120, 8);
  browser.handleKey("\t");
  browser.handleKey("\x1b[6~");
  browser.renderBody(120, 8);
  assert.equal(browser.selectedQuestion(), "question 1");
  assert.equal(browser.answerOffset(), 8);

  const pending = controller.start("pending", ctx, snapshot, () => undefined);
  browser.renderBody(120, 8);
  assert.equal(browser.selectedQuestion(), "question 1", "pending must not temporarily hide the oldest answer");
  assert.equal(browser.answerOffset(), 8, "pending must not reset its reading position");
  assert.equal(browser.currentFocus(), "detail");
  assert.equal(controller.cancel(), true);
  browser.renderBody(120, 8);
  assert.equal(browser.selectedQuestion(), "question 1", "cancel leaves the same answer selected");
  assert.equal(browser.answerOffset(), 8, "cancel preserves its reading position");
  assert.equal(browser.currentFocus(), "detail");
  assert.equal(controller.answers().length, 20, "cancel evicts no completed answer");

  release();
  await pending;
  view.close();
  await browsing;
});

test("outside a TUI a finished question still delivers its answer text", async () => {
  const { ctx, notices, widgets } = context(async () => response("plain answer"));
  (ctx as unknown as { mode: string }).mode = "rpc";
  const controller = new BtwController();
  controller.startSession();
  await controller.run("question", ctx, snapshot);
  assert.deepEqual(notices, ["plain answer"]);
  assert.deepEqual(widgets, [], "no toast is mounted where there is no editor to mount it over");

  await controller.run("", ctx, snapshot);
  assert.deepEqual(notices, ["plain answer", "plain answer"]);
});
