import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  ProtocolError,
  encodeFrame,
  type FrameV1,
} from "../../src/supervisor/protocol.ts";

const NONCE = "ab".repeat(32);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function frame(overrides: Partial<FrameV1> = {}): FrameV1 {
  return {
    version: 1,
    hostNonce: NONCE,
    supervisorGeneration: 1,
    type: "hello",
    payload: { sessionScopeId: "session", piPid: 123 },
    ...overrides,
  };
}

function rawFrame(source: string): Buffer {
  const body = Buffer.from(source, "utf8");
  const result = Buffer.alloc(4 + body.length);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

function code(error: unknown): string | undefined {
  return error instanceof ProtocolError ? error.code : undefined;
}

test("encodes the exact V1 envelope and decodes arbitrary chunk partitions", () => {
  const first = frame();
  const second = frame({
    type: "health",
    requestId: REQUEST_ID,
    requestSequence: 1,
    payload: {},
  });
  const bytes = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
  for (let split = 0; split <= bytes.length; split += 1) {
    const decoder = new FrameDecoder();
    const decoded = [
      ...decoder.push(bytes.subarray(0, split)),
      ...decoder.push(bytes.subarray(split)),
    ];
    decoder.finish();
    assert.deepEqual(decoded, [first, second]);
  }
});

test("rejects unknown, missing, malformed and contradictory envelope fields", () => {
  const invalid: unknown[] = [
    { ...frame(), unknown: true },
    { ...frame(), version: 2 },
    { ...frame(), hostNonce: "ABC" },
    { ...frame(), supervisorGeneration: 0 },
    { ...frame(), type: "bad type" },
    { ...frame(), requestId: "not-a-uuid" },
    { ...frame(), requestSequence: 0 },
    { ...frame(), eventSequence: 1.5 },
    { ...frame(), payload: [] },
  ];
  for (const value of invalid) {
    assert.throws(() => encodeFrame(value as FrameV1), (error) => code(error) === "protocol-invalid" || code(error) === "protocol-version");
  }
});

test("rejects duplicate keys at any JSON object depth", () => {
  const sources = [
    `{"version":1,"version":1,"hostNonce":"${NONCE}","supervisorGeneration":1,"type":"hello","payload":{}}`,
    `{"version":1,"hostNonce":"${NONCE}","supervisorGeneration":1,"type":"hello","payload":{"x":1,"x":2}}`,
    `{"version":1,"hostNonce":"${NONCE}","supervisorGeneration":1,"type":"hello","payload":{"\\u0078":1,"x":2}}`,
  ];
  for (const source of sources) {
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(rawFrame(source)), (error) => code(error) === "protocol-invalid");
  }
});

test("rejects invalid UTF-8, invalid lengths and truncated transports", () => {
  const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(() => new FrameDecoder().push(invalidUtf8), (error) => code(error) === "protocol-invalid");
  for (const length of [0, MAX_FRAME_BYTES + 1]) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length, 0);
    assert.throws(() => new FrameDecoder().push(header), (error) => code(error) === "protocol-frame-size");
  }
  const decoder = new FrameDecoder();
  decoder.push(encodeFrame(frame()).subarray(0, 8));
  assert.throws(() => decoder.finish(), (error) => code(error) === "protocol-truncated");
});

test("accepts the exact 1 MiB frame body boundary and rejects one byte over", () => {
  const prefix = `{"version":1,"hostNonce":"${NONCE}","supervisorGeneration":1,"type":"x","payload":{"x":"`;
  const suffix = '"}}';
  const body = prefix + "a".repeat(MAX_FRAME_BYTES - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(body), MAX_FRAME_BYTES);
  const decoder = new FrameDecoder();
  assert.equal(decoder.push(rawFrame(body)).length, 1);

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => decoder.push(oversized), (error) => code(error) === "protocol-frame-size");
});
