import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { checkCompactionAppend } from "../compat/pi-1.2-compaction-probe.ts";

test("compaction probe accepts transparent dispatch and fails closed for broken append semantics", () => {
  const prototype = InteractiveMode.prototype as unknown as { addMessageToChat: (this: unknown, message: unknown) => void };
  const original = prototype.addMessageToChat;
  try {
    assert.equal(checkCompactionAppend(), true);
    prototype.addMessageToChat = function delegated(message) { original.call(this, message); };
    assert.equal(checkCompactionAppend(), true);
    prototype.addMessageToChat = function markdownAware(message) {
      assert.deepEqual((this as { getMarkdownTransformers(): unknown[] }).getMarkdownTransformers(), []);
      original.call(this, message);
    };
    assert.equal(checkCompactionAppend(), true);
    prototype.addMessageToChat = function missingSpacer(message) { void (message as { tokensBefore: number }).tokensBefore; };
    assert.equal(checkCompactionAppend(), false);
    prototype.addMessageToChat = function dropped() {};
    assert.equal(checkCompactionAppend(), false);
    prototype.addMessageToChat = function broken() { throw new Error("drift"); };
    assert.equal(checkCompactionAppend(), false);
  } finally { prototype.addMessageToChat = original; }
});
