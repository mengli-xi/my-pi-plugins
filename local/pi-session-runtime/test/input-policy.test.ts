import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { bindInputPolicy } from "../src/input-policy.ts";

function fixture(admit: (text: string, intent: "immediate" | "after-current") => Promise<void>) {
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.message.followUp": { defaultKeys: "alt+enter" } }), history: string[] = [], notices: string[] = [];
  const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } } as any;
  const editor = new CustomEditor(tui, { borderColor: (s: string) => s, selectList: {} } as any, keys as any);
  editor.focused = true;
  editor.addToHistory = text => { history.push(text); };
  let input!: (data: string) => any, unsubscribed = false;
  const ctx = { cwd: "/tmp", ui: { addAutocompleteProvider() {}, notify: (s: string) => notices.push(s), onTerminalInput: (fn: any) => { input = fn; return () => { unsubscribed = true; }; } } } as any;
  const dispose = bindInputPolicy(ctx, editor, tui, keys, { commands: [], blockedActions: [], returnKey: "alt+/", busy: () => false, interrupt: async () => {}, leave() {}, admit, unsupported: () => "unsupported" });
  return { editor, input: (s: string) => input(s), dispose, history, notices, get unsubscribed() { return unsubscribed; } };
}

test("Enter and configured followUp action carry intent once; repeats/releases never admit", async () => {
  const calls: unknown[] = [], f = fixture(async (...args) => { calls.push(args); });
  try {
    f.editor.setText("immediate"); await f.editor.onSubmit?.("immediate");
    f.editor.setText("later"); f.input("\x1b\r"); await new Promise(resolve => setImmediate(resolve));
    f.input("\x1b[13;3:2u"); f.input("\x1b[13;3:3u");
    assert.deepEqual(calls, [["immediate", "immediate"], ["later", "after-current"]]);
    assert.deepEqual(f.history, ["immediate", "later"]); assert.equal(f.editor.getText(), "");
  } finally { await f.dispose(); }
});

test("detach drains durable admission, clears accepted draft/history once, and never resends", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => { calls++; await gate; });
  f.editor.setText("draft"); const submitting = f.editor.onSubmit?.("draft");
  let detached = false; const disposing = f.dispose().then(() => { detached = true; });
  await Promise.resolve(); assert.equal(detached, false); assert.equal(f.editor.getText(), "draft");
  f.input("\r"); release(); await submitting; await disposing;
  assert.equal(calls, 1); assert.deepEqual(f.history, ["draft"]); assert.equal(f.editor.getText(), ""); assert.equal(f.unsubscribed, true);
});

test("rejected input stays as exact draft with no history, including during detach", async () => {
  let reject!: (error: Error) => void;
  const f = fixture(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  f.editor.setText("  rejected\ntext  "); const submitting = f.editor.onSubmit?.("  rejected\ntext  ");
  const disposing = f.dispose(); reject(new Error("Agent 已关闭，先恢复再发送"));
  await submitting; await disposing;
  assert.equal(f.editor.getText(), "  rejected\ntext  "); assert.deepEqual(f.history, []); assert.match(f.notices[0]!, /先恢复/);
});

test("managed command drains before detach, preserving restored draft", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const keys = new KeybindingsManager(TUI_KEYBINDINGS), tui = { requestRender() {} } as any;
  const editor = new CustomEditor(tui, {} as any, keys as any);
  const ctx = { cwd: "/tmp", ui: { addAutocompleteProvider() {}, notify() {}, onTerminalInput: () => () => {} } } as any;
  const dispose = bindInputPolicy(ctx, editor, tui, keys, { commands: [{ name: "resume-agent", run: async () => { await gate; editor.setText("saved draft"); } }], blockedActions: [], returnKey: "alt+/", busy: () => false, interrupt: async () => {}, leave() {}, admit: async () => {}, unsupported: () => "unsupported" });
  const submitting = editor.onSubmit?.("/resume-agent");
  let detached = false; const disposing = dispose().then(() => { detached = true; });
  await Promise.resolve(); assert.equal(detached, false);
  release(); await submitting; await disposing; assert.equal(editor.getText(), "saved draft");
});
