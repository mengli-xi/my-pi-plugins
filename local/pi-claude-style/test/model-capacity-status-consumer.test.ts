import assert from "node:assert/strict";
import test from "node:test";
import modelCapacityExtension from "../../pi-model-capacity/index.ts";
import { registerCapacityAdapter } from "../../pi-model-capacity/src/registration.ts";

import {
  MODEL_CAPACITY_REQUEST_CHANNEL,
  MODEL_CAPACITY_WATCH_CHANNEL,
  STATUS_LINE_ROW_CHANNEL,
} from "../src/integration-contracts.ts";
import { ModelCapacityClient } from "../src/model-capacity-client.ts";
import { ContributedRows } from "../src/statusline/extra-lines.ts";
import {
  capacityDetailsPanelContent,
  installModelCapacityStatusConsumer,
  renderCapacityDetailsBody,
} from "../src/statusline/model-capacity.ts";

class Bus {
  readonly emitted: Array<{ channel: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
  on(channel: string, handler: (payload: unknown) => void): () => void {
    const entries = this.handlers.get(channel) ?? [];
    entries.push(handler);
    this.handlers.set(channel, entries);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = entries.indexOf(handler);
      if (index >= 0) entries.splice(index, 1);
    };
  }
  emit(channel: string, payload: unknown): void {
    this.emitted.push({ channel, payload });
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(payload);
  }
}

test("capacity bus fixtures keep release idempotent and snapshot listeners during broadcast", () => {
  const bus = new Bus();
  const seen: string[] = [];
  const release = bus.on("fixture", () => {
    seen.push("retiring");
    release();
    release();
    bus.on("fixture", () => { seen.push("replacement"); });
  });
  bus.on("fixture", () => { seen.push("peer"); });
  bus.emit("fixture", {});
  assert.deepEqual(seen, ["retiring", "peer"]);
  release();
  seen.length = 0;
  bus.emit("fixture", {});
  assert.deepEqual(seen, ["peer", "replacement"]);
  const sameHandler = () => { seen.push("same"); };
  const releaseFirst = bus.on("duplicate", sameHandler);
  const releaseSecond = bus.on("duplicate", sameHandler);
  releaseFirst();
  releaseFirst();
  seen.length = 0;
  bus.emit("duplicate", {});
  assert.deepEqual(seen, ["same"]);
  releaseSecond();
});

function setup() {
  const bus = new Bus();
  const rows = new ContributedRows();
  bus.on(STATUS_LINE_ROW_CHANNEL, (payload) => rows.handle(payload));
  const lifecycle = new Map<string, Array<(event: any, ctx: any) => void>>();
  const pi = {
    events: bus,
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: any) => void) {
      const entries = lifecycle.get(name) ?? [];
      entries.push(handler);
      lifecycle.set(name, entries);
    },
  } as never;
  const client = new ModelCapacityClient(bus as never);
  const opened: Array<{ title: string; body: string }> = [];
  const notifications: string[] = [];
  let paintDetails: (() => void) | undefined;
  const installed = installModelCapacityStatusConsumer(
    pi,
    client,
    () => true,
    (_ctx, details, onOpen) => {
      opened.push(details);
      paintDetails = () => {
        paintDetails = undefined;
        onOpen((next) => { opened.push(next); });
      };
      return new Promise<void>(() => {});
    },
  );
  let current = { provider: "fixture-gateway", id: "fixture-model" };
  const ctx = {
    sessionManager: { getSessionId: () => "session-a" },
    hasUI: true,
    get model() { return current; },
    ui: {
      theme: { fg: (_tone: string, text: string) => text },
      notify: (message: string) => { notifications.push(message); },
    },
  };
  const emitLifecycle = (name: string, event: unknown = {}) => {
    for (const handler of lifecycle.get(name) ?? []) handler(event, ctx);
  };
  return {
    bus,
    pi,
    rows,
    client,
    installed,
    opened,
    notifications,
    emitLifecycle,
    paintDetails() { paintDetails?.(); },
    setModel(value: typeof current) { current = value; },
  };
}

test("capacity details use wrap-content height and key/value body colours", () => {
  const details = { title: "Capacity", body: "Model: fixture-model\n\n5h quota\nRemaining: 1%" };
  const content = capacityDetailsPanelContent(details);
  assert.equal(content.title, "Capacity");
  assert.equal(content.body, details.body, "copy source remains plain text");
  assert.equal(content.format, "plain");
  assert.equal(content.maxVisible, 18);
  assert.equal(typeof content.renderBody, "function");

  const theme = {
    fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
  } as never;
  assert.deepEqual(renderCapacityDetailsBody(details.body, 80, theme), [
    "<muted>Model:</muted> <text>fixture-model</text>",
    "",
    "<text>5h quota</text>",
    "<muted>Remaining:</muted> <text>1%</text>",
  ]);
});

test("capacity key/value renderer wraps painted rows without changing their text", () => {
  const theme = {
    fg: (tone: string, text: string) => `\u001b[${tone === "muted" ? "2" : "0"}m${text}\u001b[0m`,
  } as never;
  const rendered = renderCapacityDetailsBody("Observed at: 2026-08-19 05:29:54.600 UTC", 24, theme);
  assert.ok(rendered.length > 1);
  const plain = rendered.join(" ").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  assert.equal(plain, "Observed at: 2026-08-19 05:29:54.600 UTC");
});

test("statusline click opens cached Fixture Gateway capacity before refreshing it live", async () => {
  const harness = setup();
  harness.emitLifecycle("session_start");
  const acquire = harness.bus.emitted.find((entry) =>
    entry.channel === MODEL_CAPACITY_WATCH_CHANNEL
    && (entry.payload as { action?: string }).action === "acquire");
  assert.deepEqual((acquire?.payload as { providers?: string[] }).providers, ["fixture-gateway"]);
  harness.bus.emit("model-capacity:snapshot-v2", {
    version: 2,
    ownerId: "fixture-owner",
    revision: 1,
    sessionId: "session-a",
    providers: [
      {
        provider: "fixture-gateway",
        state: "ready",
        models: {
          "fixture-model": {
            loadPercent: 113,
            quota: { remaining: 295, limit: 300, used: 5, resetsAt: Math.floor(Date.now() / 1_000) + 86_400 },
          },
        },
      },
      { provider: "openai-codex", state: "unavailable" },
      { provider: "xai", state: "unavailable" },
    ],
  });
  const capacityRow = rows(harness.rows)[2] ?? "";
  assert.equal(stripAnsi(capacityRow), "work │ 98.3% · 1d L113%");
  assert.match(capacityRow, /\x1b\[38;5;65m98\.3%/);
  const click = harness.rows.spliceInline(["model", "context", "work"]).spans[2]?.[0]?.onClick;
  const requestsBefore = refreshRequests(harness.bus).length;
  assert.equal(click?.(), true);
  assert.equal(click?.(), false, "an open details panel is deduplicated");
  assert.equal(harness.opened.length, 1, "cached details open synchronously");
  assert.match(harness.opened[0]?.body ?? "", /State: Refreshing/);
  assert.match(harness.opened[0]?.body ?? "", /Quota remaining: 295 \/ 300/);
  assert.equal(refreshRequests(harness.bus).length, requestsBefore, "refresh waits for the cached first frame");
  harness.paintDetails();
  assert.equal(refreshRequests(harness.bus).length, requestsBefore + 1);
  replyFresh(harness.bus, "fixture-gateway", {
    provider: "fixture-gateway",
    state: "ready",
    observedAt: 2_000,
    models: {
      "fixture-model": {
        loadPercent: 119,
        quota: { remaining: 294, limit: 300, used: 6, resetsAt: Math.floor(Date.now() / 1_000) + 86_400 },
      },
    },
  });
  await tick();
  assert.equal(harness.opened.at(-1)?.title, "fixture-gateway capacity");
  assert.match(harness.opened.at(-1)?.body ?? "", /State: Current/);
  assert.match(harness.opened.at(-1)?.body ?? "", /Quota remaining: 294 \/ 300/);
  assert.match(harness.opened.at(-1)?.body ?? "", /Load: 119%/);
  assert.match(harness.opened.at(-1)?.body ?? "", /Resets at: .* UTC/);
  assert.match(harness.opened.at(-1)?.body ?? "", /Time remaining: 1d/);
  harness.installed.dispose();
  harness.client.dispose();
});

test("failed click refresh keeps cached details and marks the panel failed", async () => {
  const harness = setup();
  harness.emitLifecycle("session_start");
  harness.bus.emit("model-capacity:snapshot-v2", {
    version: 2,
    ownerId: "fixture-owner",
    revision: 1,
    sessionId: "session-a",
    providers: [
      {
        provider: "fixture-gateway",
        state: "ready",
        observedAt: 1_000,
        models: { "fixture-model": { loadPercent: 113 } },
      },
      { provider: "openai-codex", state: "unavailable" },
      { provider: "xai", state: "unavailable" },
    ],
  });
  const click = harness.rows.spliceInline(["model", "context", "work"]).spans[2]?.[0]?.onClick;
  assert.equal(click?.(), true);
  assert.match(harness.opened[0]?.body ?? "", /State: Refreshing/);
  harness.paintDetails();
  const request = refreshRequests(harness.bus).at(-1);
  assert.ok(request);
  request.reply({
    version: 2,
    ownerId: "fixture-owner",
    revision: 2,
    sessionId: "session-a",
    providers: [
      {
        provider: "fixture-gateway",
        state: "stale",
        observedAt: 1_000,
        error: "gateway offline",
        models: { "fixture-model": { loadPercent: 113 } },
      },
      { provider: "openai-codex", state: "unavailable" },
      { provider: "xai", state: "unavailable" },
    ],
  }, {
    version: 2,
    completedAt: 2_000,
    providers: [{
      provider: "fixture-gateway",
      refreshed: false,
      state: "stale",
      observedAt: 1_000,
      error: "gateway offline",
    }],
  });
  await tick();
  assert.match(harness.opened.at(-1)?.body ?? "", /State: Refresh failed/);
  assert.match(harness.opened.at(-1)?.body ?? "", /Load: 113%/);
  assert.deepEqual(harness.notifications, ["Unable to refresh model capacity: gateway offline"]);
  harness.installed.dispose();
  harness.client.dispose();
});

test("a disabled statusline does not hold a capacity watcher", () => {
  const bus = new Bus();
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const pi = {
    events: bus,
    on(name: string, handler: (event: unknown, ctx: any) => void) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
  } as never;
  const client = new ModelCapacityClient(bus as never);
  const installed = installModelCapacityStatusConsumer(pi, client, () => false, () => {});
  const ctx = {
    sessionManager: { getSessionId: () => "session-a" },
    hasUI: true,
    model: { provider: "xai", id: "grok-4" },
  };
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  assert.equal(bus.emitted.some((entry) => entry.channel === MODEL_CAPACITY_WATCH_CHANNEL), false);
  installed.dispose();
  client.dispose();
});

test("headless sessions do not hold a capacity watcher", () => {
  const headless = {
    sessionManager: { getSessionId: () => "session-a" },
    hasUI: false,
    model: { provider: "xai", id: "grok-4" },
  };
  const bus = new Bus();
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const pi = {
    events: bus,
    on(name: string, handler: (event: unknown, ctx: any) => void) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
  } as never;
  const client = new ModelCapacityClient(bus as never);
  const installed = installModelCapacityStatusConsumer(pi, client, () => true, () => {});
  for (const handler of handlers.get("session_start") ?? []) handler({}, headless);
  assert.equal(bus.emitted.some((entry) => entry.channel === MODEL_CAPACITY_WATCH_CHANNEL), false);
  installed.dispose();
  client.dispose();
});

test("model selection releases the old provider and live-updates refreshed quota details", async () => {
  const harness = setup();
  harness.emitLifecycle("session_start");
  harness.setModel({ provider: "openai-codex", id: "gpt-5.6" });
  harness.emitLifecycle("model_select", { model: { provider: "openai-codex", id: "gpt-5.6" } });
  const watches = harness.bus.emitted
    .filter((entry) => entry.channel === MODEL_CAPACITY_WATCH_CHANNEL)
    .map((entry) => entry.payload as { action: string; providers?: string[] });
  assert.deepEqual(watches.slice(-2), [
    { version: 2, watcherId: "cc-style:statusline", action: "release", sessionId: "session-a", providers: ["fixture-gateway"] },
    { version: 2, watcherId: "cc-style:statusline", action: "acquire", sessionId: "session-a", providers: ["openai-codex"] },
  ]);
  const reset = Math.floor(Date.now() / 1_000) + 7_200;
  harness.bus.emit("model-capacity:snapshot-v2", {
    version: 2,
    ownerId: "fixture-owner",
    revision: 2,
    sessionId: "session-a",
    providers: [
      { provider: "fixture-gateway", state: "ready" },
      {
        provider: "openai-codex",
        state: "ready",
        windows: [{ kind: "five_hour", usedPercent: 12, remainingPercent: 88, resetsAt: reset }],
      },
      { provider: "xai", state: "ready" },
    ],
  });
  const codexRow = rows(harness.rows)[2] ?? "";
  assert.match(stripAnsi(codexRow), /^work │ 88% · (?:1h59m|2h)$/);
  assert.match(codexRow, /\x1b\[38;5;65m88%/);
  assert.equal(harness.rows.spliceInline(["model", "context", "work"]).spans[2]?.[0]?.onClick?.(), true);
  assert.match(harness.opened.at(-1)?.body ?? "", /State: Refreshing/);
  assert.match(harness.opened.at(-1)?.body ?? "", /Remaining: 88%/);
  harness.paintDetails();
  replyFresh(harness.bus, "openai-codex", {
    provider: "openai-codex",
    state: "ready",
    observedAt: 3_000,
    windows: [{ kind: "five_hour", usedPercent: 13, remainingPercent: 87, resetsAt: reset }],
  });
  await tick();
  assert.equal(harness.opened.at(-1)?.title, "openai-codex capacity");
  assert.match(harness.opened.at(-1)?.body ?? "", /5h quota\nRemaining: 87%\nUsed: 13%/);
  assert.match(harness.opened.at(-1)?.body ?? "", /Resets at: .* UTC\nTime remaining: (?:1h 59m|2h)/);
  harness.emitLifecycle("session_shutdown");
  assert.deepEqual(rows(harness.rows), ["model", "context", "work"]);
  harness.installed.dispose();
  harness.client.dispose();
});

test("registered neutral producer reaches the real CC client, statusline and confirmed-refresh panel", async () => {
  const harness = setup();
  modelCapacityExtension(harness.pi);
  let fetches = 0;
  const registration = registerCapacityAdapter(harness.bus, {
    provider: "fixture-gateway", intervalMs: 30_000, staleMs: 90_000,
    resolveAuth: async () => ({ apiKey: "fixture", headers: {}, fingerprint: "fixture-account" }),
    fetch: async () => {
      fetches++;
      return {
        gateway: { active: 2, queued: 1, backgroundActive: 0, maxActive: 8 },
        models: { "fixture-model": { loadPercent: 25, quota: { remaining: fetches === 1 ? 9 : 8, limit: 10 } } },
        windows: [{ kind: "other", label: "Account", usedPercent: 10, remainingPercent: 90 }],
        balances: [{ currency: "USD", remaining: 3 }],
      };
    },
  });
  try {
    harness.emitLifecycle("session_start");
    await tick();
    assert.equal(registration.accepted, true);
    const line = stripAnsi(rows(harness.rows)[2] ?? "");
    assert.match(line, /Q 9\/10 L25%/);
    assert.match(line, /\$3\.00 Account 90%/);
    const click = harness.rows.spliceInline(["model", "context", "work"]).spans[2]?.[0]?.onClick;
    assert.equal(click?.(), true);
    assert.match(harness.opened[0]?.body ?? "", /Gateway: 2 \/ 8/);
    assert.equal(fetches, 1, "opening cached details does not start network work");
    harness.paintDetails();
    await tick();
    assert.equal(fetches, 2, "actual owner performs a confirmed follow-up fetch");
    assert.match(harness.opened.at(-1)?.body ?? "", /State: Current/);
    assert.match(harness.opened.at(-1)?.body ?? "", /Quota remaining: 8 \/ 10/);
    assert.match(harness.opened.at(-1)?.body ?? "", /Currency: USD/);
    assert.match(harness.opened.at(-1)?.body ?? "", /Account · Limit quota/);
    registration.dispose();
    assert.deepEqual(rows(harness.rows), ["model", "context", "work"], "release withdraws the real CC contribution");
  } finally {
    registration.dispose();
    harness.emitLifecycle("session_shutdown");
    harness.installed.dispose();
    harness.client.dispose();
  }
});

function refreshRequests(bus: Bus): Array<{
  refreshProviders?: string[];
  reply(snapshot: unknown, refresh?: unknown): void;
}> {
  return bus.emitted
    .filter((entry) => entry.channel === MODEL_CAPACITY_REQUEST_CHANNEL
      && Array.isArray((entry.payload as { refreshProviders?: unknown }).refreshProviders))
    .map((entry) => entry.payload as {
      refreshProviders?: string[];
      reply(snapshot: unknown, refresh?: unknown): void;
    });
}

function replyFresh(bus: Bus, provider: string, freshProvider: Record<string, unknown>): void {
  const request = refreshRequests(bus).at(-1);
  assert.ok(request);
  request.reply({
    version: 2,
    ownerId: "fixture-owner",
    revision: 10,
    sessionId: "session-a",
    providers: [
      provider === "fixture-gateway" ? freshProvider : { provider: "fixture-gateway", state: "ready" },
      provider === "openai-codex" ? freshProvider : { provider: "openai-codex", state: "ready" },
      provider === "xai" ? freshProvider : { provider: "xai", state: "ready" },
    ],
  }, {
    version: 2,
    completedAt: 3_001,
    providers: [{ provider, refreshed: true, state: "ready", observedAt: freshProvider.observedAt }],
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function rows(contributed: ContributedRows): string[] {
  return contributed.spliceInline(["model", "context", "work"]).lines;
}
