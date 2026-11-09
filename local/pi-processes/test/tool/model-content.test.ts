import assert from "node:assert/strict";
import test from "node:test";
import { processToolModelContent } from "../../src/tool/register.ts";
import type { V2SuccessEnvelope } from "../../src/tool/executor.ts";

function logs(lines: Array<{ stream: "stdout" | "stderr"; text: string }>): V2SuccessEnvelope {
  return {
    version: 2,
    action: "logs",
    outcome: "success",
    hostRevision: 1,
    data: {
      process: {} as never,
      revision: 1,
      lines: lines.map((line, sequence) => ({ ...line, sequence })),
      truncated: false,
      droppedBytes: 0,
      droppedLines: 0,
    },
  };
}

test("logs expose bounded stream-aware text to the model", () => {
  assert.equal(
    processToolModelContent(logs([
      { stream: "stdout", text: "weather json" },
      { stream: "stderr", text: "warning" },
    ])),
    "Read 2 process log lines\n[stdout] weather json\n[stderr] warning",
  );
});

test("log model content truncates on a UTF-8 boundary with an explicit notice", () => {
  const content = processToolModelContent(logs([{ stream: "stdout", text: "结果".repeat(100_000) }]));
  assert.ok(Buffer.byteLength(content, "utf8") <= 131_072);
  assert.match(content, /process log content truncated to 128 KiB$/);
  assert.equal(content.includes("�"), false);
});

test("start tells the model to end its turn only while a wait is armed", () => {
  const start = (continuation: unknown) => ({ version: 2, action: "start", outcome: "success", hostRevision: 1,
    data: { process: { name: "job", continuation } } }) as V2SuccessEnvelope;
  assert.equal(processToolModelContent(start({ mode: "detached" })), "Process 'job' started");
  assert.match(processToolModelContent(start({ mode: "wait", state: "blocking", until: { kind: "exit" } })), /Waiting is armed\. End this turn now; you will be woken when the process exits\./);
  assert.match(processToolModelContent(start({ mode: "wait", state: "blocking", until: { kind: "watch", key: "ready" } })), /when watch 'ready' matches\./);
  assert.equal(processToolModelContent(start({ mode: "wait", state: "satisfied", until: { kind: "exit" } })), "Process 'job' started");
});
