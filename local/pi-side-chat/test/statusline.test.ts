import assert from "node:assert/strict";
import test from "node:test";
import {
  BTW_PENDING_LINE,
  createBtwStatus,
  formatSideStatus,
  publishSideStatus,
  withdrawSideStatus,
} from "../statusline.ts";

function context() {
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  return {
    widgets,
    statuses,
    ctx: {
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
        setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      },
    },
  };
}

/** A bus that answers the reply handshake, standing in for a loaded CC Style. */
function rowHost() {
  const emitted: Array<Record<string, unknown>> = [];
  return {
    emitted,
    pi: {
      events: {
        emit(_channel: string, payload: Record<string, unknown>) {
          emitted.push(payload);
          (payload.reply as ((accepted: true) => void) | undefined)?.(true);
        },
      },
    },
  };
}

test("Side status is contributed inline to statusline row three", () => {
  const { ctx, widgets } = context();
  const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const pi = {
    events: {
      emit(channel: string, payload: Record<string, unknown>) {
        emitted.push({ channel, payload });
        (payload.reply as ((accepted: true) => void) | undefined)?.(true);
      },
    },
  };
  assert.equal(publishSideStatus(pi as never, ctx as never, { status: "pending" }), true);
  assert.equal(emitted[0]?.channel, "statusline:row");
  assert.deepEqual(emitted[0]?.payload, {
    key: "side-chat",
    line: "Side · ephemeral · cache pending",
    placement: "inline",
    row: 3,
    align: "left",
    reply: emitted[0]?.payload.reply,
  });
  assert.deepEqual(widgets.at(-1), { key: "side-chat-status", lines: undefined });
});

test("Side status falls back to one below-editor line without a statusline host", () => {
  const { ctx, widgets } = context();
  const pi = { events: { emit: () => undefined } };
  assert.equal(publishSideStatus(pi as never, ctx as never, { status: "persisted" }), false);
  assert.deepEqual(widgets.at(-1), {
    key: "side-chat-status",
    lines: ["Side · ephemeral · cache unknown (persisted context)"],
  });
});

test("Side status formats cache usage and withdraws its owned key", () => {
  assert.equal(formatSideStatus({ status: "hit", cacheRead: 9_000, cacheWrite: 0, promptTokens: 9_100 }),
    "Side · ephemeral · cache hit 9.0k/9.1k");
  const { ctx } = context();
  const payloads: Record<string, unknown>[] = [];
  withdrawSideStatus({ events: { emit: (_channel: string, payload: Record<string, unknown>) => payloads.push(payload) } } as never, ctx as never);
  assert.equal(payloads.at(-1)?.key, "side-chat");
  assert.equal(payloads.at(-1)?.line, undefined);
});

test("BTW pending state takes its own statusline key on row three", () => {
  const { ctx, statuses } = context();
  const host = rowHost();
  const status = createBtwStatus(host.pi as never);

  status.show(ctx as never);
  assert.equal(host.emitted[0]?.key, "side-chat-btw", "BTW may not reuse the Side segment's key");
  assert.equal(host.emitted[0]?.line, BTW_PENDING_LINE);
  assert.equal(host.emitted[0]?.placement, "inline");
  assert.equal(host.emitted[0]?.row, 3);
  assert.equal(host.emitted[0]?.align, "left");
  assert.equal(BTW_PENDING_LINE.includes("/btw cancel"), true, "the pending line keeps the cancel hint");
  assert.deepEqual(statuses, [{ key: "pi-side-chat:btw", value: undefined }],
    "an accepted row leaves no duplicate native status");

  status.clear(ctx as never);
  assert.equal(host.emitted[1]?.key, "side-chat-btw");
  assert.equal(host.emitted[1]?.line, undefined);
  assert.deepEqual(statuses.at(-1), { key: "pi-side-chat:btw", value: undefined });
});

test("BTW pending state falls back to the native status without a row host", () => {
  const { ctx, statuses } = context();
  const emitted: Array<Record<string, unknown>> = [];
  const pi = { events: { emit: (_channel: string, payload: Record<string, unknown>) => emitted.push(payload) } };
  const status = createBtwStatus(pi as never);

  status.show(ctx as never);
  assert.deepEqual(statuses, [{ key: "pi-side-chat:btw", value: BTW_PENDING_LINE }]);
  status.clear(ctx as never);
  assert.deepEqual(statuses.at(-1), { key: "pi-side-chat:btw", value: undefined });
  assert.deepEqual(emitted.map((payload) => payload.line), [BTW_PENDING_LINE, undefined]);
});

test("BTW pending state without an event bus still reaches the native status", () => {
  const { ctx, statuses } = context();
  const status = createBtwStatus();
  status.show(ctx as never);
  status.clear(ctx as never);
  assert.deepEqual(statuses, [
    { key: "pi-side-chat:btw", value: BTW_PENDING_LINE },
    { key: "pi-side-chat:btw", value: undefined },
  ]);
});
