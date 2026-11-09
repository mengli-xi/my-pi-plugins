import type { Component } from "@earendil-works/pi-tui";
import { parseMouseEvents } from "pi-li-uikit/panel-mouse";

/** Historical SGR fixtures now enter the normalized Pi 1.2 component API. */
export function sendInput(component: Component, data: string): void {
  const events = parseMouseEvents(data);
  if (!events.length) { component.handleInput?.(data); return; }
  for (const event of events) component.handleMouse?.({
    type: event.kind,
    button: event.kind === "wheel" ? "none" : event.button === 0 ? "left" : event.button === 1 ? "middle" : "right",
    x: event.col, y: event.row, screenX: event.col, screenY: event.row,
    width: 100, height: 40,
    shift: event.shift, alt: event.alt, ctrl: event.ctrl,
    wheelDelta: event.wheel,
  });
}

/** A completed left click at component-local coordinates, as Pi fullscreen dispatches it. */
export function click(component: Component | undefined, row = 0, col = 0, button: "left" | "right" = "left"): boolean {
  return component?.handleMouse?.({
    type: "click", button, x: col, y: row, screenX: col, screenY: row, width: 100, height: 40,
    shift: false, alt: false, ctrl: false,
  })?.handled === true;
}
