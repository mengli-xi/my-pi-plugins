import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Container } from "@earendil-works/pi-tui";
import { InteractiveMode, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_USER_MESSAGES } from "../src/config.ts";
import { formatUserMessageTimestamp, installCompactUserMessages } from "../src/user-message.ts";
import { flushInternalsHealth, setHealthPath } from "../src/internals.ts";

const dir = mkdtempSync(join(tmpdir(), "cc-user-times-"));
setHealthPath(join(dir, "health.json"));
test.after(async () => { await flushInternalsHealth(); rmSync(dir, { recursive: true, force: true }); });
initTheme("dark");
const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("user timestamps use local HH:mm with a date across days or years", () => {
  const today = new Date("2026-10-14T10:00:00");
  assert.equal(formatUserMessageTimestamp("2026-10-14T08:09:00", today), "08:09");
  assert.equal(formatUserMessageTimestamp("2026-10-13T08:09:00", today), "10-13 08:09");
  assert.equal(formatUserMessageTimestamp("2025-10-13T08:09:00", today), "2025-10-13 08:09");
  assert.equal(formatUserMessageTimestamp("invalid", today), undefined);
});

test("identical user text binds to its own entry timestamp and follows branch changes", () => {
  const owner = InteractiveMode.prototype as unknown as { addMessageToChat: (this: { chatContainer: Container }, message: { content: string }) => void };
  const original = owner.addMessageToChat;
  owner.addMessageToChat = function(message) { this.chatContainer.addChild(new UserMessageComponent(message.content)); };
  const native = owner.addMessageToChat;
  const events = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler) };
  const first = { role: "user", content: "same text", timestamp: 0 };
  const second = { role: "user", content: "same text", timestamp: 0 };
  let entries = [
    { type: "message", timestamp: "2026-10-14T08:09:00", message: first },
    { type: "message", timestamp: "2026-10-14T09:10:00", message: second },
  ];
  const ctx = { hasUI: false, sessionManager: { getBranch: () => entries } };
  const dispose = installCompactUserMessages(pi as never, DEFAULT_USER_MESSAGES);
  try {
    const mode = { chatContainer: new Container() };
    owner.addMessageToChat.call(mode, first);
    owner.addMessageToChat.call(mode, second);
    events.get("session_start")?.({}, ctx);
    const [a, b] = mode.chatContainer.children;
    assert.match(strip(a!.render(80)[0]!), /user .*08:09/);
    assert.match(strip(b!.render(80)[0]!), /user .*09:10/);
    entries = [{ ...entries[0]!, timestamp: "2026-10-14T10:11:00" }];
    events.get("session_tree")?.({}, ctx);
    assert.match(strip(a!.render(80)[0]!), /user .*10:11/);
    assert.doesNotMatch(strip(b!.render(80)[0]!), /09:10/, "a removed branch entry cannot retain a stale clock");
  } finally { dispose(); assert.equal(owner.addMessageToChat, native); owner.addMessageToChat = original; }
});
