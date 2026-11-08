import assert from "node:assert/strict";
import test from "node:test";
import { unreadCompletionsForAgentV1 } from "../../src/persistence/unread.js";

const completion = (id: string) => ({ completion_id: id });
const inbox = (id: string, completionId: string, extra: Record<string, unknown> = {}) => ({ inbox_id: id, completion_id: completionId, state: "appended", ...extra });

test("unread projection attributes Main and nested completion inboxes to one Agent", () => {
  const partition = {
    agent: { agent_id:"parent" },
    completions: [completion("cmp-own")],
    inbox: [inbox("inb-child", "cmp-child", { recipient: {agent_id:"parent"} }), inbox("inb-read", "cmp-read", { ui_read_at: "2026-09-15T00:00:00.000Z" })],
  } as any;
  const state = {
    root: { inbox: [inbox("inb-own", "cmp-own"), inbox("inb-other", "cmp-other"), inbox("inb-pending", "cmp-own", { state: "pending-append" })] },
    agents: [partition],
  } as any;
  assert.equal(unreadCompletionsForAgentV1(state, partition), 2);
});
