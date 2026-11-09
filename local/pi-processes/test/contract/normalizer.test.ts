import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { StreamNormalizer } from "../../src/logs/normalizer.ts";

function normalize(chunks: Uint8Array[]) {
  const normalizer = new StreamNormalizer();
  const records = chunks.flatMap((chunk) => normalizer.push(chunk));
  records.push(...normalizer.finish());
  return { records, counters: normalizer.counters };
}

function allPartitions(bytes: Buffer): Uint8Array[][] {
  const partitions: Uint8Array[][] = [[bytes]];
  for (let index = 0; index <= bytes.length; index += 1) {
    partitions.push([bytes.subarray(0, index), bytes.subarray(index)]);
  }
  for (let first = 0; first <= bytes.length; first += 3) {
    const second = Math.min(bytes.length, first + 5);
    partitions.push([bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second)]);
  }
  return partitions;
}

test("normalization is invariant across arbitrary stream chunks", () => {
  const source = Buffer.from(
    "α\r\n\u001b[31mred\u001b[0m\tX\n"
      + "\u001b]52;c;secret\u0007safe\r"
      + "\u001bPignored\u001b\\ok\u202E!\npartial",
    "utf8",
  );
  const expected = normalize([source]);
  for (const chunks of allPartitions(source)) {
    assert.deepEqual(normalize(chunks), expected);
  }
  assert.deepEqual(expected.records.map((record) => record.text), ["α", "red    X", "safe", "ok!", "partial"]);
  assert.deepEqual(expected.records.map((record) => record.terminated), [true, true, true, true, false]);
});

test("retains empty lines, normalizes CR/LF and flushes only non-empty EOF partials", () => {
  const result = normalize([Buffer.from("\n\r\n\rA")]);
  assert.deepEqual(result.records, [
    { text: "", terminated: true, truncated: false, utf8ReplacementBytes: 0 },
    { text: "", terminated: true, truncated: false, utf8ReplacementBytes: 0 },
    { text: "", terminated: true, truncated: false, utf8ReplacementBytes: 0 },
    { text: "A", terminated: false, truncated: false, utf8ReplacementBytes: 0 },
  ]);
});

test("replaces invalid UTF-8 and strips unsafe C0/C1 and bidi controls", () => {
  const bytes = Buffer.concat([
    Buffer.from("a"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("\u0000\u0085\u2066b\n"),
  ]);
  const result = normalize([bytes]);
  assert.equal(result.records[0]?.text, "a�(b");
  assert.equal(result.records[0]?.utf8ReplacementBytes, 3);
  assert.equal(result.counters.utf8ReplacementBytes, 3);
});

test("emits exactly 65536 UTF-8 bytes then discards overflow until terminator", () => {
  const source = Buffer.from(`${"a".repeat(65_536)}XYZ\nnext\n`);
  const result = normalize([source]);
  assert.equal(Buffer.byteLength(result.records[0]!.text), 65_536);
  assert.equal(result.records[0]?.truncated, true);
  assert.equal(result.records[0]?.terminated, false);
  assert.equal(result.records[1]?.text, "next");
  assert.equal(result.counters.droppedBytes, 3);
  assert.equal(result.counters.droppedLines, 1);
});

test("does not split a multi-byte code point at the line boundary", () => {
  const source = Buffer.from(`${"a".repeat(65_535)}界tail\n`);
  const result = normalize([source]);
  assert.equal(Buffer.byteLength(result.records[0]!.text), 65_535);
  assert.equal(result.records[0]?.text.endsWith("a"), true);
  assert.equal(result.counters.droppedBytes, Buffer.byteLength("界tail"));
});
