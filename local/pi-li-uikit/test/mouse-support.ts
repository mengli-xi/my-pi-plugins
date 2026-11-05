import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { parseMouseEvents } from "../src/panel-mouse.ts";

export function mouseInput(component: Component, data: string): void {
  for (const raw of parseMouseEvents(data)) {
    component.handleMouse?.({
      type: raw.kind, button: raw.kind === "wheel" ? "none" : ["left", "middle", "right", "none"][raw.button] as TuiMouseEvent["button"],
      x: raw.col, y: raw.row, screenX: raw.col, screenY: raw.row, width: 80, height: 24,
      shift: raw.shift, alt: raw.alt, ctrl: raw.ctrl,
      ...(raw.kind === "wheel" ? { wheelDelta: raw.wheel } : {}),
    });
  }
}
