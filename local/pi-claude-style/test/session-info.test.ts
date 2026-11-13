import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";

import {
  auditInternals,
  flushInternalsHealth,
  declareProbes,
  resetInternals,
  setHealthPath,
} from "../src/internals.ts";
import {
  installSessionInfoPopup,
  PROBES,
  type SessionInfoReport,
} from "../src/session-info.ts";

const BODY = "ID: abc\n\nTokens\nTotal: 1,234";
const REPORT = `Session Info\n\n${BODY}`;

/**
 * A stand-in for pi's own handler, writing what the real one writes: a Spacer
 * followed by a Text carrying the whole report.
 */
function installFakeHandler(body: string = REPORT): { calls: number } {
  const state = { calls: 0 };
  (InteractiveMode.prototype as unknown as Record<string, unknown>)
    .handleSessionCommand = function fakeHandler(this: {
      chatContainer?: { addChild(child: unknown): void };
    }): void {
      state.calls += 1;
      this.chatContainer?.addChild(new Spacer(1));
      this.chatContainer?.addChild(new Text(body, 0, 0));
    };
  return state;
}

function makeMode() {
  const shown: unknown[] = [];
  const mode = Object.create(InteractiveMode.prototype) as Record<string, unknown>;
  mode.chatContainer = { addChild: (child: unknown) => shown.push(child) };
  return { mode, shown };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

let dir: string;
let restore: () => void = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-info-"));
  resetInternals();
  setHealthPath(join(dir, "health.json"));
});

afterEach(async () => {
  restore();
  restore = () => {};
  delete (InteractiveMode.prototype as unknown as Record<string, unknown>)
    .handleSessionCommand;
  await flushInternalsHealth();
  resetInternals();
  rmSync(dir, { recursive: true, force: true });
});

test("the original report is captured and handed to the editor-slot presenter", () => {
  installFakeHandler();
  const presented: SessionInfoReport[] = [];
  restore = installSessionInfoPopup((report) => {
    presented.push(report);
    return true;
  });

  const { mode, shown } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);

  assert.deepEqual(shown, [], "报告不应再直接写进 transcript");
  assert.equal(presented[0]?.title, "Session info");
  assert.equal(presented[0]?.body, BODY);
  assert.ok(presented[0]?.renderBody(40).some((line) => line.includes("Total:")));
});

test("the container is restored even though the handler wrote to a stand-in", () => {
  installFakeHandler();
  restore = installSessionInfoPopup(() => true);

  const { mode } = makeMode();
  const before = mode.chatContainer;
  (mode.handleSessionCommand as () => void).call(mode);
  assert.equal(mode.chatContainer, before);
});

test("a throwing handler falls back to pi's own output, and records the drift", () => {
  (InteractiveMode.prototype as unknown as Record<string, unknown>)
    .handleSessionCommand = function throwing(this: {
      chatContainer?: { addChild(child: unknown): void };
    }): void {
      // Fails only while writing into the sink; the fallback call sees a real
      // container and succeeds, which is exactly the shape of a shape change.
      const target = this.chatContainer as { addChild(child: unknown): void; real?: boolean };
      if (!target.real) throw new Error("内部结构变了");
      target.addChild(new Text("pi 原样输出", 1, 0));
    };
  let presented = 0;
  restore = installSessionInfoPopup(() => {
    presented++;
    return true;
  });

  const shown: unknown[] = [];
  const mode = Object.create(InteractiveMode.prototype) as Record<string, unknown>;
  mode.chatContainer = { real: true, addChild: (child: unknown) => shown.push(child) };
  (mode.handleSessionCommand as () => void).call(mode);

  assert.equal(presented, 0, "拿不到报告就不应打开面板");
  assert.equal(shown.length, 1, "应当回退到 pi 自己的输出");

  declareProbes(PROBES);
  const row = auditInternals().find((r) => r.id === "session-info.capture");
  assert.equal(row?.state, "broken");
  assert.equal(row?.detail, "内部结构变了");
});

test("a handler that writes no readable text is drift, not an empty report", () => {
  (InteractiveMode.prototype as unknown as Record<string, unknown>)
    .handleSessionCommand = function noText(this: {
      chatContainer?: { addChild(child: unknown): void };
    }): void {
      // A future pi that renders the report with a component instead of Text.
      this.chatContainer?.addChild(new Spacer(1));
    };
  let presented = 0;
  restore = installSessionInfoPopup(() => {
    presented++;
    return true;
  });

  const { mode } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);

  assert.equal(presented, 0);
  declareProbes(PROBES);
  const row = auditInternals().find((r) => r.id === "session-info.capture");
  assert.equal(row?.state, "broken");
});

test("an unavailable presenter falls back to Pi's native inline report", () => {
  installFakeHandler();
  restore = installSessionInfoPopup(() => false);

  const { mode, shown } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);
  assert.equal(shown.length, 2, "fallback 应重新运行原 handler");
  assert.equal((shown[1] as { text?: unknown }).text, REPORT);
});

test("a throwing presenter also falls back to Pi's native inline report", () => {
  installFakeHandler();
  restore = installSessionInfoPopup(() => {
    throw new Error("stale UI");
  });

  const { mode, shown } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);
  assert.equal((shown[1] as { text?: unknown }).text, REPORT);
});

test("an asynchronously unavailable presenter falls back after loading", async () => {
  installFakeHandler();
  restore = installSessionInfoPopup(async () => false);

  const { mode, shown } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);
  assert.deepEqual(shown, [], "异步 presenter 完成前不能提前输出");
  await settle();
  assert.equal((shown[1] as { text?: unknown }).text, REPORT);
});

test("a rejected asynchronous presenter also falls back", async () => {
  installFakeHandler();
  restore = installSessionInfoPopup(async () => {
    throw new Error("load failed");
  });

  const { mode, shown } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);
  await settle();
  assert.equal((shown[1] as { text?: unknown }).text, REPORT);
});

test("a missing handler leaves the prototype alone", () => {
  delete (InteractiveMode.prototype as unknown as Record<string, unknown>)
    .handleSessionCommand;
  restore = installSessionInfoPopup(() => true);

  assert.equal(
    (InteractiveMode.prototype as unknown as Record<string, unknown>)
      .handleSessionCommand,
    undefined,
  );
  declareProbes(PROBES);
  const row = auditInternals()
    .find((r) => r.id === "session-info.handleSessionCommand");
  assert.equal(row?.state, "missing");
});

test("the disposer puts pi's handler back", () => {
  const state = installFakeHandler();
  const original = (InteractiveMode.prototype as unknown as Record<string, unknown>)
    .handleSessionCommand;
  const dispose = installSessionInfoPopup(() => true);
  assert.notEqual(
    (InteractiveMode.prototype as unknown as Record<string, unknown>)
      .handleSessionCommand,
    original,
  );
  dispose();
  assert.equal(
    (InteractiveMode.prototype as unknown as Record<string, unknown>)
      .handleSessionCommand,
    original,
  );
  assert.equal(state.calls, 0);
});

test("lazy native report is materialized through public render, then reflows in the panel", () => {
  let renders = 0;
  class LazyReport extends Text {
    constructor() { super("", 0, 0); }
    override render(width: number): string[] {
      renders++;
      this.setText(REPORT);
      return super.render(width);
    }
  }
  (InteractiveMode.prototype as unknown as Record<string, unknown>).handleSessionCommand = function(this: { chatContainer: { addChild(child: unknown): void } }) {
    this.chatContainer.addChild(new LazyReport());
  };
  let captured: SessionInfoReport | undefined;
  restore = installSessionInfoPopup((report) => { captured = report; return true; });
  const { mode, shown } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);
  assert.equal(captured?.body, BODY);
  assert.deepEqual(shown, []);
  assert.ok(captured?.renderBody(8).length! > captured?.renderBody(80).length!);
  assert.ok(renders >= 3);
});

test("deduplicates only the leading native title, including ANSI styling", () => {
  installFakeHandler("\x1b[1mSession Info\x1b[0m\n\nID: abc\nSession Info belongs in this later field");
  let captured: SessionInfoReport | undefined;
  restore = installSessionInfoPopup((report) => { captured = report; return true; });
  const { mode } = makeMode();
  (mode.handleSessionCommand as () => void).call(mode);
  assert.equal(captured?.body, "ID: abc\nSession Info belongs in this later field");
  assert.ok(captured?.renderBody(80)[0]?.startsWith("ID:"));
});
