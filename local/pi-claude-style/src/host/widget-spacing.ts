/** Pi 1.3's above-editor widget builder inserts one leading Spacer(1).
 * Keep widgets adjacent to the working block without reading working state or
 * changing any component. This is one private seam, shared by Main and views.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { declareProbes, markBroken, markOk, type Probe } from "../internals.ts";

type RenderWidgets = (this: unknown, container: Container, widgets: Map<string, Component>, spacerWhenEmpty: boolean, leadingSpacer: boolean) => void;
const prototype = InteractiveMode.prototype as unknown as { renderWidgetContainer?: RenderWidgets };
const KEY = Symbol.for("pi.claude-style.widget-spacing.v2");
interface Patch { original: RenderWidgets; patched: RenderWidgets; owners: Set<symbol> }
const globals = globalThis as Record<PropertyKey, unknown>;

/** Probe behaviour, not function source: the stock Bun binary renames locals. */
function nativeShape(method: unknown): method is RenderWidgets {
  const registry = globals[KEY] as WeakMap<object, Patch> | undefined;
  const installed = registry?.get(prototype);
  if (installed && installed.patched === method) method = installed.original;
  if (typeof method !== "function" || method.length !== 4) return false;
  try {
    const widget: Component = { render: () => ["widget"], invalidate() {} };
    for (const empty of [false, true]) for (const leading of [false, true]) for (const spacerWhenEmpty of [false, true]) {
      const container = new Container();
      const widgets = new Map(empty ? [] : [["widget", widget]]);
      method.call(undefined, container, widgets, spacerWhenEmpty, leading);
      const spacer = empty ? spacerWhenEmpty : leading;
      if (container.children.length !== Number(spacer) + Number(!empty)) return false;
      if (spacer && (container.children[0]?.render(10).join("|") !== "" || container.children[0]?.render(10).length !== 1)) return false;
      if (!empty && container.children.at(-1) !== widget) return false;
    }
    return true;
  } catch { return false; }
}

export const PROBES: readonly Probe[] = [{
  id: "shell.widgetSpacing",
  needs: "InteractiveMode.prototype.renderWidgetContainer(container, widgets, spacerWhenEmpty, leadingSpacer)",
  breaks: "above-editor widget 前恢复 Pi 原生空行；Working 与折叠 Todo 之间再次出现间隔",
  check: () => nativeShape(prototype.renderWidgetContainer),
}];

export function installWidgetSpacing(): () => void {
  declareProbes(PROBES);
  // Main and SDK hosts may export different InteractiveMode prototypes in Pi
  // 1.5. Unwrap only this host's exact patch; drift still fails nativeShape.
  const registry = (globals[KEY] ??= new WeakMap()) as WeakMap<object, Patch>;
  let state = registry.get(prototype);
  if (!state || prototype.renderWidgetContainer !== state.patched) {
    const original = prototype.renderWidgetContainer;
    if (!nativeShape(original)) {
      markBroken("shell.widgetSpacing", "widget builder shape changed; keeping Pi spacing");
      return () => {};
    }
    const patched: RenderWidgets = function (container, widgets, spacerWhenEmpty, leadingSpacer) {
      // Preserve the empty-container spacer and all below-editor calls. For a
      // populated above-editor container only the leading spacer flag changes.
      return original.call(this, container, widgets, spacerWhenEmpty,
        leadingSpacer === true && widgets instanceof Map && widgets.size > 0 ? false : leadingSpacer);
    };
    state = { original, patched, owners: new Set() };
    prototype.renderWidgetContainer = patched;
    registry.set(prototype, state);
    markOk("shell.widgetSpacing");
  }
  const installed = state;
  const owner = Symbol("widget-spacing.owner");
  installed.owners.add(owner);
  return () => {
    installed.owners.delete(owner);
    if (installed.owners.size > 0) return;
    if (prototype.renderWidgetContainer === installed.patched) prototype.renderWidgetContainer = installed.original;
    if (registry.get(prototype) === installed) registry.delete(prototype);
  };
}
