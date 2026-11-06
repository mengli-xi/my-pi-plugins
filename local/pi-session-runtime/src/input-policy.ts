import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, isKeyRelease, isKeyRepeat, matchesKey, type EditorComponent, type KeybindingsManager, type SlashCommand, type TUI } from "@earendil-works/pi-tui";

export interface ManagedCommand extends SlashCommand {
  /** Native delegates to this view's original editor submit callback. */
  run: "native" | ((argumentsText: string) => void | Promise<void>);
  acceptsArguments?: boolean;
}
export type InputIntent = "immediate" | "after-current";
export interface InputPolicy {
  commands: readonly ManagedCommand[];
  blockedActions: readonly Parameters<KeybindingsManager["matches"]>[1][];
  returnKey: string;
  busy(): boolean;
  interrupt(): Promise<void>;
  leave(): void;
  /** Resolves only after durable admission. Rejection preserves the submitted draft. */
  admit(text: string, intent: InputIntent): Promise<void>;
  unsupported(command: string): string;
  /** Consumer input policy; filter event types only for keys this callback handles. */
  onInput?(data: string): { consume: true } | void;
  /** Default empty Ctrl+D returns; Side may instead confirm destruction. */
  emptyDelete?(): void;
}

/** Public editor/input policy, with no Task or renderer implementation. */
export function bindInputPolicy(ctx: ExtensionContext, editor: EditorComponent, tui: TUI, keys: KeybindingsManager, policy: InputPolicy): () => Promise<void> {
  // CustomEditor is public, but instanceof is not stable across Pi's Jiti module graphs.
  const custom = editor as EditorComponent & Pick<CustomEditor, "onEscape" | "onAction" | "isShowingAutocomplete" | "focused">;
  if (typeof custom.onAction !== "function" || typeof custom.isShowingAutocomplete !== "function") throw new Error("Managed input requires the public CustomEditor action API");
  const commands = new Map(policy.commands.map(command => [command.name, command]));
  const complete = new CombinedAutocompleteProvider([...policy.commands], ctx.cwd);
  ctx.ui.addAutocompleteProvider(next => ({
    triggerCharacters: next.triggerCharacters,
    getSuggestions: (lines, line, col, options) => lines.slice(0, line + 1).join("\n").trimStart().startsWith("/")
      ? complete.getSuggestions(lines, line, col, options) : next.getSuggestions(lines, line, col, options),
    applyCompletion: (lines, line, col, item, prefix) => prefix.startsWith("/") ? complete.applyCompletion(lines, line, col, item, prefix) : next.applyCompletion(lines, line, col, item, prefix),
    shouldTriggerFileCompletion: (...args) => next.shouldTriggerFileCompletion?.(...args) ?? false,
  }));
  let native = editor.onSubmit, active = true, closing = false, pending = false, actionPending = false;
  let admission: Promise<void> | undefined, submittedDraft: string | undefined;
  const error = (cause: unknown) => { if (active) ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error"); };
  const interrupt = () => {
    if (actionPending) return;
    actionPending = true;
    // Fence a whole batch of terminal input before switching or aborting.
    queueMicrotask(() => { void policy.interrupt().catch(error).finally(() => { actionPending = false; }); });
  };
  const leave = () => {
    if (actionPending) return;
    actionPending = true;
    queueMicrotask(() => policy.leave());
  };
  const originalEscape = custom.onEscape;
  // Native CustomEditor calls this only after autocomplete/dialog dispatch, so their Escape wins.
  const escape = () => { if (active && !closing && !pending && policy.busy()) interrupt(); };
  custom.onEscape = escape;
  const submit = async (text: string, intent: InputIntent = "immediate") => {
    if (!active || closing || pending || actionPending) return;
    if (submittedDraft?.trim() === text.trim()) text = submittedDraft;
    submittedDraft = undefined;
    // Native Editor clears text before invoking onSubmit, including paste markers.
    editor.setText(text); tui.requestRender();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("!")) { ctx.ui.notify("Direct shell input is unavailable in this view", "warning"); return; }
    if (trimmed.startsWith("/")) {
      const [name, ...rest] = trimmed.slice(1).split(/\s+/u), args = rest.join(" ");
      const command = commands.get(name!);
      if (!command || (args && !command.acceptsArguments)) { ctx.ui.notify(policy.unsupported(name!), "warning"); return; }
      try {
        if (command.run === "native") await native?.(trimmed);
        else {
          pending = true;
          editor.setText("");
          await (admission = Promise.resolve(command.run(args)));
        }
      } catch (cause) { editor.setText(text); error(cause); }
      finally { pending = false; admission = undefined; }
      tui.requestRender(); return;
    }
    pending = true;
    try {
      await (admission = policy.admit(text, intent));
      if (active) { editor.addToHistory?.(text); if (editor.getText() === text) editor.setText(""); }
    } catch (cause) { error(cause); }
    finally { pending = false; admission = undefined; if (active) tui.requestRender(); }
  };
  // Pi assigns the native submit callback after invoking an editor factory.
  const getSubmit = () => submit;
  Object.defineProperty(editor, "onSubmit", { configurable: true, get: getSubmit, set: value => { native = value; } });
  const unsubscribe = ctx.ui.onTerminalInput(data => {
    if (!active) return;
    if (actionPending || pending || closing) return { consume: true };
    // Filter only actions owned here. Other event types/keys retain native Pi semantics.
    const press = !isKeyRelease(data) && !isKeyRepeat(data);
    const handled = policy.onInput?.(data);
    if (handled) return handled;
    if (matchesKey(data, policy.returnKey as Parameters<typeof matchesKey>[1])) { if (press) leave(); return { consume: true }; }
    if (matchesKey(data, "ctrl+c") || keys.matches(data, "app.clear")) { if (press) { if (policy.busy()) interrupt(); else leave(); } return { consume: true }; }
    if (matchesKey(data, "ctrl+d") || keys.matches(data, "app.exit")) {
      if (!editor.getText()) { if (press) { if (policy.emptyDelete) policy.emptyDelete(); else leave(); } return { consume: true }; }
      return;
    }
    if (matchesKey(data, "ctrl+z") || keys.matches(data, "app.suspend")) { if (press) ctx.ui.notify("Suspend is disabled in a managed view", "warning"); return { consume: true }; }
    if (policy.blockedActions.some(action => keys.matches(data, action))) { if (press) ctx.ui.notify("This action is unavailable in this view", "warning"); return { consume: true }; }
    if (keys.matches(data, "app.message.followUp") && custom.focused) { if (press) void submit(editor.getExpandedText?.() ?? editor.getText(), "after-current"); return { consume: true }; }
    if (!press && custom.focused && !custom.isShowingAutocomplete() && policy.busy() && matchesKey(data, "escape")) return { consume: true };
    if (keys.matches(data, "tui.input.submit") && custom.focused) {
      if (!press) return { consume: true };
      submittedDraft = editor.getExpandedText?.() ?? editor.getText();
    }
  });
  return async () => {
    closing = true;
    await admission?.catch(() => undefined);
    active = false; unsubscribe();
    if (Object.getOwnPropertyDescriptor(editor, "onSubmit")?.get === getSubmit)
      Object.defineProperty(editor, "onSubmit", { configurable: true, writable: true, value: native });
    if (custom.onEscape === escape) custom.onEscape = originalEscape;
  };
}
