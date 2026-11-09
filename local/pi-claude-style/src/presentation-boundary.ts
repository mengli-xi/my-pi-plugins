import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { decorateToolRenderers, type DecorateToolOptions } from "./tool-renderer.ts";

/** Pi owns resolver registration and replacement; the runtime owns its closures. */
export function installToolPresentationBoundary(
  pi: ExtensionAPI,
  options: DecorateToolOptions,
): () => void {
  let active = true;
  const cache = new WeakMap<ToolRenderers, Map<string, ToolRenderers>>();
  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    if (!active || !renderers) return renderers;
    let byName = cache.get(renderers);
    const cached = byName?.get(toolName);
    if (cached) return cached;
    try {
      const decorated = decorateToolRenderers(toolName, renderers, options);
      if (!byName) cache.set(renderers, byName = new Map());
      byName.set(toolName, decorated);
      return decorated;
    } catch {
      return renderers;
    }
  });
  return () => { active = false; };
}
