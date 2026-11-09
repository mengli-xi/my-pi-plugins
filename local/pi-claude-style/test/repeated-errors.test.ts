import assert from "node:assert/strict";
import test from "node:test";
import { click } from "./native-mouse.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  ExtensionRunner,
  SessionManager,
  initTheme,
  InteractiveMode,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { installClaudeAssistantMessages } from "../src/assistant-message.ts";
import {
  ErrorGroupComponent,
  installFinalNoticeAbsorption,
  RepeatedErrorCollapser,
} from "../src/repeated-errors.ts";
import type { AssistantMessagesConfig } from "../src/types.ts";

initTheme("dark");

function errorMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "example-api",
    provider: "example-provider",
    model: "gpt-5.6-sol-max",
    stopReason: "error",
    errorMessage: text,
    timestamp,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as unknown as AssistantMessage;
}

function row(component: Component): string {
  return component.render(200).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").trim();
}

const first = "Provider backend connection failed (attempts=1, stage=backend_transport, backend_http=503, request_id=req_ONE, retryable=true)";
const second = "Provider backend connection failed (attempts=2, stage=backend_transport, backend_http=503, request_id=req_TWO, retryable=true)";
const third = "Provider backend connection failed (attempts=3, stage=backend_transport, backend_http=503, request_id=req_THREE, retryable=true)";
const upstreamFirst = "Provider upstream returned error code 4027 (attempts=2, stage=event_assemble/upstream_error, backend_http=503, upstream_code=4027, request_id=req_UP_ONE, vendor_log_id=log_ONE, retryable=true)";
const upstreamSecond = "Provider upstream returned error code 4027 (attempts=2, stage=event_assemble/upstream_error, backend_http=503, upstream_code=4027, request_id=req_UP_TWO, vendor_log_id=log_TWO, retryable=true)";
const assistantConfig: AssistantMessagesConfig = {
  enabled: true,
  style: "claude",
  marker: "●",
  markerColor: "accent",
  collapsedThinking: "preview",
  hideCodeFenceMarkers: true,
  typewriter: {
    enabled: false,
    adaptive: true,
    frameMs: 50,
    renderBudgetMs: 8,
    maxFrameMs: 200,
    minCharsPerFrame: 3,
    maxCharsPerFrame: 160,
    targetLagMs: 160,
    finalDrainMs: 1_200,
  },
};

test("collapses consecutive retry errors while retaining every raw attempt", () => {
  const opened: Array<{ heading: string; body: string }> = [];
  const collapser = new RepeatedErrorCollapser(
    () => undefined,
    (heading, body) => {
      opened.push({ heading, body });
      return true;
    },
    () => 4_000,
  );
  collapser.startRun();

  const identities = [{}, {}, {}];
  const childSets: Component[][] = [[{} as Component], [{} as Component], [{} as Component]];
  assert.equal(collapser.presentAssistant(identities[0]!, errorMessage(first, 1_000), false, childSets[0], 1), false);
  assert.equal(collapser.presentAssistant(identities[1]!, errorMessage(second, 2_000), false, childSets[1], 1), true);
  assert.equal(collapser.presentAssistant(identities[2]!, errorMessage(third, 3_000), false, childSets[2], 1), true);

  assert.equal(childSets[0]!.length, 1);
  assert.ok(childSets[0]![0] instanceof ErrorGroupComponent);
  assert.equal(row(childSets[0]![0]!), "Provider backend connection failed ×3");
  assert.deepEqual(childSets[1], []);
  assert.deepEqual(childSets[2], []);

  assert.equal(collapser.absorbFinalNotice(`Retry failed after 3 attempts: ${third}`), true);
  assert.equal(row(childSets[0]![0]!), "Provider backend connection failed 3/3");
  assert.equal(click(childSets[0]![0], 0, 0), true);
  assert.equal(opened[0]?.heading, "Errors (3)");
  assert.match(opened[0]?.body ?? "", /Attempt 1 · 1970-01-01T00:00:01\.000Z[\s\S]*req_ONE/u);
  assert.match(opened[0]?.body ?? "", /Attempt 2 · 1970-01-01T00:00:02\.000Z[\s\S]*req_TWO/u);
  assert.match(opened[0]?.body ?? "", /Attempt 3 · 1970-01-01T00:00:03\.000Z[\s\S]*req_THREE/u);
  assert.match(opened[0]?.body ?? "", /Final · 1970-01-01T00:00:04\.000Z[\s\S]*Retry failed after 3 attempts/u);
});

test("collapses an upstream error envelope with provider-prefixed log IDs", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  collapser.startRun();
  const firstChildren: Component[] = [{} as Component];
  const secondChildren: Component[] = [{} as Component];
  assert.equal(
    collapser.presentAssistant({}, errorMessage(upstreamFirst, 1_000), false, firstChildren, 1),
    false,
  );
  assert.equal(
    collapser.presentAssistant({}, errorMessage(upstreamSecond, 2_000), false, secondChildren, 1),
    true,
  );
  const aggregate = firstChildren.find((child) => child instanceof ErrorGroupComponent);
  assert.ok(aggregate);
  assert.equal(row(aggregate), "Provider upstream returned error code 4027 ×2");
  assert.equal(
    collapser.absorbFinalNotice(`Retry failed after 1 attempt: ${upstreamSecond}`),
    true,
  );
  assert.equal(row(aggregate), "Provider upstream returned error code 4027 2/2");
});

test("keeps structurally different provider envelopes in separate groups", () => {
  const variants = [
    upstreamSecond.replace("error code 4027", "request rejected"),
    upstreamSecond.replace("event_assemble/upstream_error", "backend_transport"),
    upstreamSecond.replace("backend_http=503", "backend_http=502"),
    upstreamSecond.replace("upstream_code=4027", "upstream_code=4028"),
    upstreamSecond.replace("retryable=true", "retryable=false"),
  ];
  for (const variant of variants) {
    const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
    collapser.startRun();
    const firstChildren: Component[] = [{} as Component];
    const variantChildren: Component[] = [{} as Component];
    assert.equal(
      collapser.presentAssistant({}, errorMessage(upstreamFirst, 1_000), false, firstChildren, 1),
      false,
    );
    assert.equal(
      collapser.presentAssistant({}, errorMessage(variant, 2_000), false, variantChildren, 1),
      false,
      variant,
    );
    assert.equal(
      firstChildren.some((child) => child instanceof ErrorGroupComponent),
      false,
      variant,
    );
  }
});

test("a single provider failure keeps Pi's native error and final notice", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  collapser.startRun();
  const nativeChild = {} as Component;
  const children: Component[] = [nativeChild];
  assert.equal(
    collapser.presentAssistant({}, errorMessage(first, 1_000), false, children, 1),
    false,
  );
  assert.deepEqual(children, [nativeChild]);
  assert.equal(collapser.absorbFinalNotice(`Retry failed after 1 attempt: ${first}`), false);
});

test("Pi assistant and final-notice paths share one aggregate row", () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  const pi = {
    on(type: string, handler: (event: unknown, ctx: unknown) => void) {
      const current = handlers.get(type) ?? [];
      current.push(handler);
      handlers.set(type, current);
    },
  } as unknown as ExtensionAPI;
  const opened: string[] = [];
  const collapser = new RepeatedErrorCollapser(
    () => undefined,
    (_heading, body) => {
      opened.push(body);
      return true;
    },
    () => 4_000,
  );
  const restoreAssistant = installClaudeAssistantMessages(
    pi,
    assistantConfig,
    undefined,
    (_heading, body) => {
      opened.push(body);
      return true;
    },
    undefined,
    undefined,
    collapser,
  );
  const restoreNotices = installFinalNoticeAbsorption(pi, collapser);
  try {
    collapser.startRun();
    const firstComponent = new AssistantMessageComponent(errorMessage(first, 1_000));
    const secondComponent = new AssistantMessageComponent(errorMessage(second, 2_000));
    assert.match(row(firstComponent), /Provider backend connection failed ×2/u);
    assert.deepEqual(secondComponent.render(200), []);

    const children: Component[] = [firstComponent, secondComponent];
    const showError = InteractiveMode.prototype.showError as unknown as
      (this: unknown, message: string) => void;
    showError.call({
      chatContainer: { children, addChild: (child: Component) => children.push(child) },
      ui: { requestRender() {} },
    }, `Retry failed after 2 attempts: ${second}`);
    assert.equal(children.length, 2, "final retry notice stays inside the aggregate");
    const aggregate = (firstComponent as unknown as { contentContainer: { children: Component[] } })
      .contentContainer.children.find((child) => child instanceof ErrorGroupComponent);
    assert.ok(aggregate);
    assert.equal(row(aggregate), "Provider backend connection failed 2/2");
    assert.equal(click(aggregate, 0, 0), true);
    assert.match(opened[0] ?? "", /Final · 1970-01-01T00:00:04\.000Z/u);
  } finally {
    restoreNotices();
    restoreAssistant();
  }
});

test("repeated updates of one component do not increment and keep its projection", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  collapser.startRun();
  const identity = {};
  const originalChildren: Component[] = [{} as Component];
  const message = errorMessage(first, 1_000);
  assert.equal(collapser.presentAssistant(identity, message, false, originalChildren, 2), false);
  const children: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant(identity, message, false, children, 2), false);
  assert.deepEqual(children.length, 1);

  const secondChildren: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(second, 2_000), false, secondChildren, 2), true);
  const aggregate = children.find((child) => child instanceof ErrorGroupComponent);
  assert.ok(aggregate);
  assert.equal(originalChildren.some((child) => child instanceof ErrorGroupComponent), false);
  assert.doesNotMatch(row(aggregate), /×3/u);

  collapser.settleRun();
  const rebuilt: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant(identity, message, false, rebuilt, 2), true);
  assert.strictEqual(
    rebuilt.find((child) => child instanceof ErrorGroupComponent),
    aggregate,
    "a settled aggregate survives later invalidation",
  );
});

test("different failures and visible assistant content break the sequence", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  collapser.startRun();
  const firstChildren: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(first, 1), false, firstChildren, 1), false);

  const other = first.replace("backend_http=503", "backend_http=502");
  const otherChildren: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(other, 2), false, otherChildren, 1), false);
  assert.notStrictEqual(firstChildren[0], otherChildren[0]);

  const visible = errorMessage(second, 3);
  visible.content = [{ type: "text", text: "provider returned partial output" }];
  assert.equal(collapser.presentAssistant({}, visible, false, [{} as Component], 1), false);
});

test("terminal control text is removed from the aggregate and detail panel", () => {
  const opened: string[] = [];
  const collapser = new RepeatedErrorCollapser(
    () => undefined,
    (_heading, body) => {
      opened.push(body);
      return true;
    },
  );
  collapser.startRun();
  const firstChildren: Component[] = [{} as Component];
  const secondChildren: Component[] = [{} as Component];
  const unsafeFirst = first
    .replace("backend_http=503", "backend_http=503, detail=line-one\r\nline-two")
    .replace("req_ONE", "req_\u001b]8;;https://example.invalid\u0007ONE\u001b]8;;\u0007");
  const unsafeSecond = second
    .replace("backend_http=503", "backend_http=503, detail=line-one\nline-two")
    .replace("req_TWO", "req_\u202eTWO");
  assert.equal(collapser.presentAssistant({}, errorMessage(unsafeFirst, 1), false, firstChildren, 1), false);
  assert.equal(collapser.presentAssistant({}, errorMessage(unsafeSecond, 2), false, secondChildren, 1), true);
  const aggregate = firstChildren.find((child) => child instanceof ErrorGroupComponent);
  assert.ok(aggregate);
  assert.doesNotMatch(row(aggregate), /[\u001b\u202e]/u);
  assert.equal(
    collapser.absorbFinalNotice(
      `Retry failed after 2 attempts: ${unsafeSecond}\u001b]8;;https://example.invalid\u0007`,
    ),
    true,
  );
  assert.equal(click(aggregate, 0, 0), true);
  assert.doesNotMatch(opened[0] ?? "", /[\u001b\u0007\u202e\r]/u);
  assert.match(opened[0] ?? "", /line-one\nline-two/u);
});

test("run boundaries and unrelated notices prevent cross-run aggregation", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  const before: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(first, 1), false, before, 1), false);

  collapser.startRun();
  const firstRun: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(first, 2), false, firstRun, 1), false);
  collapser.breakSequence();
  const afterNotice: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(second, 3), false, afterNotice, 1), false);
  assert.notStrictEqual(firstRun[0], afterNotice[0]);

  collapser.settleRun();
  assert.equal(collapser.absorbFinalNotice(`Retry failed after 2 attempts: ${second}`), false);
  const rebuilt: Component[] = [{} as Component];
  assert.equal(
    collapser.presentAssistant({}, errorMessage(first, 3), false, rebuilt, 1),
    false,
    "historical components that were not part of the live run stay native",
  );
  collapser.startRun();
  const staleIdentity = {};
  const staleChildren: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant(staleIdentity, errorMessage(first, 4), false, staleChildren, 1), false);
  collapser.reset();
  collapser.startRun();
  const resetChildren: Component[] = [{} as Component];
  assert.equal(
    collapser.presentAssistant(staleIdentity, errorMessage(second, 5), false, resetChildren, 1),
    false,
    "session reset clears component identity as well as the current group",
  );

  collapser.reset();
  collapser.startRun();
  const nextRun: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(second, 4), false, nextRun, 1), false);
  assert.notStrictEqual(afterNotice[0], nextRun[0]);
});

const gatewayError = "Error: Provider service temporarily unavailable: upstream_error: upstream error upstream_code=3004 (upstream_code=3004, retryable=true)";

test("five gateway errors without stage collapse and absorb the final notice", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  collapser.startRun();
  const attempts = Array.from({ length: 5 }, () => [{} as Component]);
  for (const [index, children] of attempts.entries()) {
    assert.equal(collapser.presentAssistant({}, errorMessage(gatewayError, index + 1), false, children, 1), index > 0);
  }
  const aggregate = attempts[0]![0];
  assert.ok(aggregate instanceof ErrorGroupComponent);
  assert.equal(row(aggregate), "Provider service temporarily unavailable: upstream_error: upstream error upstream_code=3004 ×5");
  assert.ok(attempts.slice(1).every((children) => children.length === 0));
  assert.equal(collapser.absorbFinalNotice(`Retry failed after 4 attempts: ${gatewayError}`), true);
  assert.equal(row(aggregate), "Provider service temporarily unavailable: upstream_error: upstream error upstream_code=3004 5/5");
  assert.equal(aggregate.details().split(gatewayError).length - 1, 6);
});

test("plain errors from other providers collapse with the entire error as summary", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  collapser.startRun();
  const firstChildren: Component[] = [{} as Component];
  for (const [index, provider] of ["other-provider", "another-provider"].entries()) {
    const message = errorMessage("Service temporarily unavailable", index + 1);
    message.provider = provider;
    assert.equal(collapser.presentAssistant({}, message, false, index ? [{} as Component] : firstChildren, 1), index > 0);
  }
  const aggregate = firstChildren[0];
  assert.ok(aggregate instanceof ErrorGroupComponent);
  assert.equal(row(aggregate), "Service temporarily unavailable ×2");
  assert.equal(collapser.absorbFinalNotice("Retry failed after 1 attempt: Service temporarily unavailable"), true);
  assert.equal(row(aggregate), "Service temporarily unavailable 2/2");
});

test("only known varying fields and wrappers are normalized", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  collapser.startRun();
  const firstChildren: Component[] = [{} as Component];
  const raw = "Gateway unavailable (attempts=1, request_id=req_A, vendor_log_id=log_A, retryable=false)";
  const repeated = "  Error:\tRetry failed after 3 attempts: Error: Gateway   unavailable (attempts=9, request_id=req_B, vendor_log_id=log_B, retryable=false)";
  assert.equal(collapser.presentAssistant({}, errorMessage(raw, 1), false, firstChildren, 1), false);
  assert.equal(collapser.presentAssistant({}, errorMessage(repeated, 2), false, [{} as Component], 1), true);
  const aggregate = firstChildren[0];
  assert.ok(aggregate instanceof ErrorGroupComponent);
  assert.match(aggregate.details(), /req_A/u);
  assert.match(aggregate.details(), /req_B/u);

  for (const [a, b] of [
    [gatewayError, gatewayError.replace("(upstream_code=3004", "(upstream_code=3005")],
    ["Unavailable (trace_id=one)", "Unavailable (trace_id=two)"],
    ["Unavailable id=one", "Unavailable id=two"],
  ]) {
    collapser.reset();
    collapser.startRun();
    const children: Component[] = [{} as Component];
    assert.equal(collapser.presentAssistant({}, errorMessage(a!, 1), false, children, 1), false);
    assert.equal(collapser.presentAssistant({}, errorMessage(b!, 2), false, [{} as Component], 1), false);
    assert.equal(children[0] instanceof ErrorGroupComponent, false);
  }
});


test("normalizes complete request/log identifiers with optional namespace prefixes", () => {
  for (const field of ["request_id", "log_id", "vendor_request_id", "vendor_log_id", "edge_proxy_log_id"]) {
    const opened: string[] = [];
    const collapser = new RepeatedErrorCollapser(() => undefined, (_title, body) => {
      opened.push(body);
      return true;
    });
    collapser.startRun();
    const children: Component[] = [{} as Component];
    assert.equal(collapser.presentAssistant({}, errorMessage(`Unavailable (${field}=one)`, 1), false, children, 1), false);
    assert.equal(collapser.presentAssistant({}, errorMessage(`Unavailable (${field}=two)`, 2), false, [{} as Component], 1), true);
    const aggregate = children[0];
    assert.ok(aggregate instanceof ErrorGroupComponent);
    assert.match(aggregate.details(), /one/u);
    assert.match(aggregate.details(), /two/u);
    assert.equal(click(aggregate, 0, 0), true);
    assert.ok(opened[0]?.includes(`${field}=one`));
  }
});

test("unknown field suffixes are preserved in the error signature", () => {
  for (const [first, second] of [
    ["Invalid configuration: max-attempts=3", "Invalid configuration: max-attempts=5"],
    ["Unavailable (x-request_id=a)", "Unavailable (x-request_id=b)"],
    ["Unavailable (request_id_extra=a)", "Unavailable (request_id_extra=b)"],
    ["Unavailable (request_id=a=b)", "Unavailable (request_id=c=d)"],
  ]) {
    const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
    collapser.startRun();
    const children: Component[] = [{} as Component];
    assert.equal(collapser.presentAssistant({}, errorMessage(first!, 1), false, children, 1), false);
    assert.equal(collapser.presentAssistant({}, errorMessage(second!, 2), false, [{} as Component], 1), false);
    assert.equal(children[0] instanceof ErrorGroupComponent, false);
  }
});

test("semicolon-delimited diagnostics distinguish errors and final notices", () => {
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  const first = "Service unavailable (request_id=a;upstream_code=3004)";
  const repeated = "Service unavailable (request_id=b;upstream_code=3004)";
  const different = "Service unavailable (request_id=c;upstream_code=3005)";
  collapser.startRun();
  const children: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(first, 1), false, children, 1), false);
  assert.equal(collapser.presentAssistant({}, errorMessage(different, 2), false, [{} as Component], 1), false);
  assert.equal(children[0] instanceof ErrorGroupComponent, false);

  collapser.reset();
  collapser.startRun();
  const repeatedChildren: Component[] = [{} as Component];
  assert.equal(collapser.presentAssistant({}, errorMessage(first, 1), false, repeatedChildren, 1), false);
  assert.equal(collapser.presentAssistant({}, errorMessage(repeated, 2), false, [{} as Component], 1), true);
  const aggregate = repeatedChildren[0];
  assert.ok(aggregate instanceof ErrorGroupComponent);
  assert.equal(collapser.absorbFinalNotice(`Retry failed after 2 attempts: ${different}`), false);
  assert.equal(row(aggregate), "Service unavailable ×2");
  assert.doesNotMatch(aggregate.details(), /Final ·/u);
});


test("extension info and warning notices break consecutive assistant error groups", () => {
  const pi = { on() {} } as unknown as ExtensionAPI;
  const collapser = new RepeatedErrorCollapser(() => undefined, () => false);
  const restoreAssistant = installClaudeAssistantMessages(
    pi, assistantConfig, undefined, undefined, undefined, undefined, collapser,
  );
  const restoreNotices = installFinalNoticeAbsorption(pi, collapser);
  try {
    const runner = new ExtensionRunner(
      [], {} as ConstructorParameters<typeof ExtensionRunner>[1], process.cwd(),
      SessionManager.inMemory(), {} as ConstructorParameters<typeof ExtensionRunner>[4],
    );
    for (const type of ["info", "warning"] as const) {
      collapser.reset();
      collapser.startRun();
      const first = new AssistantMessageComponent(errorMessage("Service unavailable", 1));
      const children: Component[] = [first];
      const view = {
        chatContainer: { children, addChild: (child: Component) => children.push(child) },
        ui: { requestRender() {} },
      };
      runner.setUIContext({
        ...runner.getUIContext(),
        notify(message, noticeType) {
          // Test the real native notice components without making showStatus
          // a production dependency: extensions only call public ui.notify.
          const show = noticeType === "warning"
            ? InteractiveMode.prototype.showWarning
            : Reflect.get(InteractiveMode.prototype, "showStatus");
          show.call(view, message);
        },
      });
      runner.createContext().ui.notify("intervening visible notice", type);
      const second = new AssistantMessageComponent(errorMessage("Service unavailable", 2));
      children.push(second);
      assert.match(row(first), /Service unavailable/u);
      assert.match(row(second), /Service unavailable/u);
      const transcript = children.map(row).join("\n");
      assert.match(transcript, /intervening visible notice/u);
      assert.doesNotMatch(transcript, /×2/u);
      assert.equal(collapser.absorbFinalNotice("Retry failed after 2 attempts: Service unavailable"), false);
    }
  } finally {
    restoreNotices();
    restoreAssistant();
  }
});
