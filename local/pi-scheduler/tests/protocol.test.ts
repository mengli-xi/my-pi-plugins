import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeFrame,
  FrameDecoder,
  type Envelope,
  type SchedulerRequest,
  type SchedulerResponse,
} from "../src/protocol.ts";

test("encodes and decodes a single request envelope", () => {
  const envelope: Envelope<SchedulerRequest> = { id: 1, body: { type: "ping" } };
  const decoder = new FrameDecoder<SchedulerRequest>();
  const out = decoder.push(encodeFrame(envelope));
  assert.deepEqual(out, [envelope]);
});

test("reassembles a frame split across chunks", () => {
  const envelope: Envelope<SchedulerResponse> = {
    id: 7,
    body: { ok: true, type: "pong" },
  };
  const line = encodeFrame(envelope);
  const decoder = new FrameDecoder<SchedulerResponse>();
  const mid = Math.floor(line.length / 2);
  assert.deepEqual(decoder.push(line.slice(0, mid)), []);
  assert.deepEqual(decoder.push(line.slice(mid)), [envelope]);
});

test("delivers multiple frames arriving in one chunk, in order", () => {
  const decoder = new FrameDecoder<SchedulerRequest>();
  const a: Envelope<SchedulerRequest> = { id: 1, body: { type: "task.list" } };
  const b: Envelope<SchedulerRequest> = { id: 2, body: { type: "task.delete", id: "x" } };
  const out = decoder.push(encodeFrame(a) + encodeFrame(b));
  assert.deepEqual(out.map((e) => e.id), [1, 2]);
});

test("ignores blank keepalive lines", () => {
  const decoder = new FrameDecoder<SchedulerRequest>();
  assert.deepEqual(decoder.push("\n\n"), []);
});

test("rejects a frame with no id or body", () => {
  const decoder = new FrameDecoder<SchedulerRequest>();
  assert.throws(() => decoder.push(`${JSON.stringify({ nope: 1 })}\n`), /missing id\/body/);
});

test("rejects an oversized frame that never terminates", () => {
  const decoder = new FrameDecoder<SchedulerRequest>(64);
  assert.throws(() => decoder.push("x".repeat(128)), /exceeded max size/);
});

test("occupancy registration carries sessionId and pid", () => {
  const envelope: Envelope<SchedulerRequest> = {
    id: 3,
    body: { type: "occupancy.register", sessionId: "s-1", pid: 4242 },
  };
  const decoder = new FrameDecoder<SchedulerRequest>();
  const [out] = decoder.push(encodeFrame(envelope));
  assert.deepEqual(out!.body, { type: "occupancy.register", sessionId: "s-1", pid: 4242 });
});
