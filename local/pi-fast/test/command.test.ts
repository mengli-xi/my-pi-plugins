import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * The state file lives under the agent dir; select a scratch directory before
 * the module under test resolves it.
 */
const home = mkdtempSync(join(tmpdir(), "pi-fast-home-"));
process.env.PI_CODING_AGENT_DIR = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { default: piFast } = await import("../index.ts");
const { FAST_TIER, SESSION_STATE_ENTRY_TYPE } = await import("../state.ts");

type Handler = (
  event: { type: string; payload?: unknown; [key: string]: unknown },
  ctx: unknown,
) => unknown;

interface SlotPayload {
  key: string;
  placement?: string;
  line?: string;
}

interface Harness {
  command: RegisteredCommand;
  request: (payload: unknown, provider: string | undefined) => unknown;
  notifications: string[];
  /** statusline:row slot payloads, in emission order. */
  slots: SlotPayload[];
  branch: () => SessionEntry[];
  sessionStart: () => void;
  sessionTree: (entries: readonly SessionEntry[]) => void;
  modelSelect: (model: { id: string; provider: string }) => void;
  ctx: ExtensionCommandContext;
}

function build(
  model: { id: string; provider: string } | undefined,
  initialEntries: readonly SessionEntry[] = [],
): Harness {
  let hook: Handler | undefined;
  let command: RegisteredCommand | undefined;
  let onSessionStart: Handler | undefined;
  let onSessionTree: Handler | undefined;
  let onModelSelect: Handler | undefined;
  const notifications: string[] = [];
  const slots: SlotPayload[] = [];
  const branchEntries = [...initialEntries];
  let entrySequence = initialEntries.length;

  const pi = {
    on: (event: string, handler: Handler) => {
      if (event === "before_provider_request") hook = handler;
      if (event === "session_start") onSessionStart = handler;
      if (event === "session_tree") onSessionTree = handler;
      if (event === "model_select") onModelSelect = handler;
    },
    events: {
      emit: (channel: string, payload: unknown) => {
        if (channel === "statusline:row") slots.push(payload as SlotPayload);
      },
      on: () => () => {},
    },
    registerCommand: (_name: string, cmd: RegisteredCommand) => {
      command = cmd;
    },
    appendEntry: (customType: string, data: unknown) => {
      const parentId = branchEntries.at(-1)?.id ?? null;
      branchEntries.push({
        type: "custom",
        id: `fast-state-${++entrySequence}`,
        parentId,
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
  } as unknown as ExtensionAPI;

  piFast(pi);
  assert.ok(hook, "extension must subscribe to before_provider_request");
  assert.ok(command, "extension must register /fast");
  assert.ok(onSessionStart, "extension must publish its slot on session_start");
  assert.ok(onSessionTree, "extension must restore state on session_tree");
  assert.ok(onModelSelect, "extension must publish its slot on model_select");

  const contextState = {
    model,
    sessionManager: { getBranch: () => [...branchEntries] },
    ui: { notify: (message: string) => void notifications.push(message) },
  };
  const ctx = contextState as unknown as ExtensionCommandContext;

  return {
    command,
    notifications,
    slots,
    ctx,
    branch: () => [...branchEntries],
    sessionStart: () =>
      void onSessionStart!({ type: "session_start", reason: "startup" }, ctx),
    sessionTree: (entries) => {
      branchEntries.splice(0, branchEntries.length, ...entries);
      void onSessionTree!(
        { type: "session_tree", oldLeafId: null, newLeafId: branchEntries.at(-1)?.id ?? null },
        ctx,
      );
    },
    modelSelect: (nextModel) => {
      const previousModel = contextState.model;
      contextState.model = nextModel;
      void onModelSelect!(
        { type: "model_select", model: nextModel, previousModel, source: "set" },
        ctx,
      );
    },
    request: (payload, provider) =>
      hook!({ type: "before_provider_request", payload }, { model: provider ? { provider } : undefined }),
  };
}

const BODY = { model: "gpt-5.6-sol", input: [] };
const CODEX = { id: "gpt-5.6-sol", provider: "openai-codex" };
const YELLOW = "[33m";
const DIM = "[90m";

beforeEach(() => {
  // Each test starts from a clean persisted state.
  rmSync(join(home, "pi-fast.json"), { force: true });
});

test("off by default: requests pass through untouched", () => {
  const h = build(CODEX);
  assert.equal(h.request(BODY, "openai-codex"), undefined);
});

test("/fast toggles injection for this session", async () => {
  const h = build(CODEX);

  await h.command.handler("", h.ctx);
  const fast = h.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(fast.service_tier, FAST_TIER);
  assert.match(h.notifications[0], /on/);
  const latest = h.branch().at(-1);
  assert.equal(latest?.type, "custom");
  assert.equal(latest?.type === "custom" ? latest.customType : undefined, SESSION_STATE_ENTRY_TYPE);

  await h.command.handler("", h.ctx);
  assert.equal(h.request(BODY, "openai-codex"), undefined);
});

test("session override survives runtime replacement but does not leak to a fresh session", async () => {
  const first = build(CODEX);
  await first.command.handler("on", first.ctx);
  const fast = first.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(fast.service_tier, FAST_TIER);

  // Reload/resume/fork creates a fresh extension instance but keeps this
  // branch's entries, so session_start reconstructs the override.
  const replacement = build(CODEX, first.branch());
  replacement.sessionStart();
  const restored = replacement.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(restored.service_tier, FAST_TIER);

  // A genuinely new session has no branch-local entry and follows global off.
  const fresh = build(CODEX);
  fresh.sessionStart();
  assert.equal(fresh.request(BODY, "openai-codex"), undefined);
});

test("rewind and tree navigation restore the selected branch's fast state", async () => {
  const h = build(CODEX);
  await h.command.handler("on", h.ctx);
  const enabledBranch = h.branch();

  h.sessionTree([]); // rewind to before the /fast state entry
  assert.equal(h.request(BODY, "openai-codex"), undefined);

  h.sessionTree(enabledBranch);
  const restored = h.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(restored.service_tier, FAST_TIER);
});

test("/fast all persists to every instance", async () => {
  const first = build(CODEX);
  await first.command.handler("all on", first.ctx);

  const second = build(CODEX);
  const fast = second.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(fast.service_tier, FAST_TIER);

  // Turning all off from the second session reaches the first — it re-reads
  // the file because it holds no override of its own after "all".
  await second.command.handler("all off", second.ctx);
  assert.equal(first.request(BODY, "openai-codex"), undefined);
});

test("a session override outranks the global default", async () => {
  const h = build(CODEX);
  await h.command.handler("all on", h.ctx);
  await h.command.handler("off", h.ctx); // this session opts out
  assert.equal(h.request(BODY, "openai-codex"), undefined);

  // ...while a fresh session still follows the global on.
  const other = build(CODEX);
  const fast = other.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(fast.service_tier, FAST_TIER);
});

test("`all` clears this session's override", async () => {
  const h = build(CODEX);
  await h.command.handler("off", h.ctx); // pin the session off
  await h.command.handler("all on", h.ctx); // all speaks for this session too
  const fast = h.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(fast.service_tier, FAST_TIER);

  const latest = h.branch().at(-1);
  assert.equal(latest?.type, "custom");
  assert.deepEqual(latest?.type === "custom" ? latest.data : undefined, { enabled: null });

  // The clear marker prevents the older "off" entry from returning when Pi
  // replaces the extension runtime.
  const replacement = build(CODEX, h.branch());
  replacement.sessionStart();
  const restored = replacement.request(BODY, "openai-codex") as Record<string, unknown>;
  assert.equal(restored.service_tier, FAST_TIER);
});

test("the statusline slot tracks this session's effective state", async () => {
  const h = build(CODEX);

  h.sessionStart();
  assert.equal(h.slots.length, 1);
  assert.equal(h.slots[0].key, "fast");
  assert.equal(h.slots[0].placement, "slot");
  assert.ok(h.slots[0].line?.startsWith(DIM), "off renders the dim icon");

  await h.command.handler("on", h.ctx);
  assert.ok(h.slots[1].line?.startsWith(YELLOW), "on renders the yellow icon");

  await h.command.handler("off", h.ctx);
  assert.ok(h.slots[2].line?.startsWith(DIM));
});

test("the statusline hides fast when the current model does not support it", async () => {
  const h = build({ id: "claude-sonnet", provider: "anthropic" });

  h.sessionStart();
  assert.equal(h.slots[0].line, undefined, "unsupported providers withdraw the slot");

  await h.command.handler("on", h.ctx);
  assert.equal(h.slots[1].line, undefined, "enabling fast does not show it for an unsupported provider");

  h.modelSelect(CODEX);
  assert.ok(h.slots[2].line?.startsWith(YELLOW), "switching to a supported model restores the enabled style");

  await h.command.handler("off", h.ctx);
  h.modelSelect({ id: "claude-sonnet", provider: "anthropic" });
  assert.equal(h.slots[4].line, undefined, "switching away withdraws the supported off icon too");
});

test("status reports scope without changing anything", async () => {
  const h = build(CODEX);
  await h.command.handler("status", h.ctx);
  assert.match(h.notifications[0], /following the all-sessions default/);
  assert.equal(h.request(BODY, "openai-codex"), undefined);

  await h.command.handler("on", h.ctx);
  await h.command.handler("status", h.ctx);
  assert.match(h.notifications[2], /this session only/);
});

test("unknown arguments warn instead of toggling", async () => {
  const h = build(CODEX);
  await h.command.handler("turbo", h.ctx);
  assert.match(h.notifications[0], /Unknown argument/);
  assert.equal(h.request(BODY, "openai-codex"), undefined);
});


test("read-only agent dir reports save failure without clearing the session override", async () => {
  const h = build(CODEX);
  await h.command.handler("on", h.ctx);
  const branch = h.branch();
  const slotCount = h.slots.length;
  chmodSync(home, 0o555);
  try {
    await h.command.handler("all on", h.ctx);
    assert.match(h.notifications.at(-1)!, /Failed to save fast default/);
    assert.match(h.notifications.at(-1)!, /EACCES|EPERM/);
    assert.match(h.notifications.at(-1)!, /pi-fast\.json/);
    assert.deepEqual(h.branch(), branch, "no clear marker after a failed write");
    assert.equal(h.slots.length, slotCount, "no success refresh after a failed write");
    assert.equal((h.request(BODY, "openai-codex") as Record<string, unknown>).service_tier, FAST_TIER);
    await h.command.handler("status", h.ctx);
    assert.match(h.notifications.at(-1)!, /on.*this session only/);
    const replacement = build(CODEX, h.branch());
    replacement.sessionStart();
    assert.equal((replacement.request(BODY, "openai-codex") as Record<string, unknown>).service_tier, FAST_TIER);
  } finally {
    chmodSync(home, 0o755);
  }
});
