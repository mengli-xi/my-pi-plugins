import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { installSideVisibility, SIDE_VISIBILITY_PROBES } from "../compat/pi-1.2-side-visibility.ts";

test("Side visibility filters inherited history and both compaction paths without changing Main", () => {
  const rendered: unknown[][] = [], appended: unknown[] = [];
  const side = Object.create(InteractiveMode.prototype);
  const mainRender = (InteractiveMode.prototype as unknown as { renderSessionEntries: unknown }).renderSessionEntries;
  side.renderSessionEntries = (entries: unknown[]) => rendered.push(entries);
  side.addMessageToChat = (message: unknown) => appended.push(message);
  const native = { render: side.renderSessionEntries, append: side.addMessageToChat };
  const release = installSideVisibility(side, new Set(["main"]), "boundary");
  const entries = [
    { type: "message", id: "main", message: { role: "assistant", content: [] } },
    { type: "custom_message", id: "boundary", customType: "boundary", display: false },
    { type: "compaction", id: "summary", summary: "private Main knowledge" },
    { type: "message", id: "side", message: { role: "assistant", content: [] } },
  ] as SessionEntry[];
  side.renderSessionEntries(entries);
  assert.deepEqual(rendered, [[entries[3]]]);
  side.addMessageToChat({ role: "compactionSummary", summary: "private Main knowledge" });
  side.addMessageToChat({ role: "assistant", content: [] });
  assert.deepEqual(appended, [{ role: "assistant", content: [] }]);
  assert.equal((InteractiveMode.prototype as unknown as { renderSessionEntries: unknown }).renderSessionEntries, mainRender);
  assert.throws(() => side.renderSessionEntries([{ type: "message" }]), /refusing to render/);
  release(); assert.equal(side.renderSessionEntries, native.render); assert.equal(side.addMessageToChat, native.append);
});

test("render behavior probe accepts transparent wrappers and rejects no-op or changed calls", () => {
  const prototype = InteractiveMode.prototype as unknown as { renderSessionEntries: (...args: any[]) => void };
  const original = prototype.renderSessionEntries;
  try {
    assert.equal(SIDE_VISIBILITY_PROBES[0]!.check(), true);
    prototype.renderSessionEntries = function (...args) { return original.apply(this, args); };
    assert.equal(SIDE_VISIBILITY_PROBES[0]!.check(), true);
    prototype.renderSessionEntries = function (entries, options) {
      return original.call(this, entries, { ...options, populateHistory: true });
    };
    assert.equal(SIDE_VISIBILITY_PROBES[0]!.check(), false);
    prototype.renderSessionEntries = () => {};
    assert.equal(SIDE_VISIBILITY_PROBES[0]!.check(), false);
    assert.throws(() => installSideVisibility(Object.create(prototype), new Set(), "boundary"), /incompatible Pi/);
  } finally { prototype.renderSessionEntries = original; }
});
