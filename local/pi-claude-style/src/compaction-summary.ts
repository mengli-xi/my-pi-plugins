import { CompactionSummaryMessageComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { chatChildren, interactiveUserMessagePrototype, TIMESTAMP_BINDING_PROBE, type AppendMessage, type TimestampOwner } from "./compat/user-message.ts";
import { declareProbes, markBroken, markOk } from "./internals.ts";
import type { TextOpener } from "./openers.ts";
import { presentationPrototype } from "./presentation-owner.ts";

export function installCompactCompactionSummaries(
  pi: ExtensionAPI,
  openText: TextOpener,
  getTheme: () => Theme | undefined,
): () => void {
  declareProbes([TIMESTAMP_BINDING_PROBE]);
  const owner = presentationPrototype(pi, interactiveUserMessagePrototype<TimestampOwner>(), "mode");
  const append = owner.addMessageToChat;
  if (typeof append !== "function") {
    markBroken(TIMESTAMP_BINDING_PROBE.id, "addMessageToChat 不可用，保留原生压缩摘要");
    return () => {};
  }
  let active = true;
  const patched: AppendMessage = function (message, options) {
    // Pi 1.5 adds compactionSummary through the already-probed append/container
    // seam. Capture the public message here, never the component's private message.
    // Only this role is decorated; missing/changed contracts keep native output.
    const children = message.role === "compactionSummary" ? chatChildren(this) : undefined;
    const start = children?.length ?? 0;
    append.call(this, message, options);
    if (message.role !== "compactionSummary") return;
    if (!children) {
      markBroken(TIMESTAMP_BINDING_PROBE.id, "chatContainer.children 不可用，保留原生压缩摘要");
      return;
    }
    if (typeof message.summary !== "string" || !Number.isFinite(message.tokensBefore) || message.tokensBefore < 0) return;
    const summary = message.summary;
    for (const child of children.slice(start)) {
      if (!(child instanceof CompactionSummaryMessageComponent) || !Object.isExtensible(child)) continue;
      if (["render", "handleMouse"].some(key => Object.getOwnPropertyDescriptor(child, key)?.configurable === false)) continue;
      const component: Component = child;
      const render = component.render;
      const mouse = component.handleMouse;
      const label = `---- [compaction] compacted from ${message.tokensBefore} tokens ------`;
      Object.defineProperties(component, {
        render: { configurable: true, writable: true, value(width: number) {
          if (!active) return render.call(this, width);
          if (width <= 0) return [];
          const line = truncateToWidth(label, width);
          return [getTheme()?.fg("dim", line) ?? line];
        } },
        handleMouse: { configurable: true, writable: true, value(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
          if (active && event.type === "click" && event.button === "left"
            && openText("Compaction summary", summary || "（本次压缩摘要为空）", {
              format: "markdown", hideCodeFenceMarkers: false,
            })) return { handled: true };
          return mouse?.call(this, event);
        } },
      });
    }
    markOk(TIMESTAMP_BINDING_PROBE.id);
  };
  owner.addMessageToChat = patched;
  return () => {
    active = false;
    if (owner.addMessageToChat === patched) owner.addMessageToChat = append;
  };
}
