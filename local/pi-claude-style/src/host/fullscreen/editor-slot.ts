import type { TUI } from "@earendil-works/pi-tui";

/**
 * The editor-slot geometry registry UIKit panels read to sit on the editor's
 * bottom edge. The key keeps Pinned Layout's name so no consumer changes; only
 * the resolver path remains (the per-TUI `providers` map belonged to Pinned's
 * retired regular-mode engine).
 */
const EDITOR_SLOT_GEOMETRY_KEY = Symbol.for("pi.pinned-layout.editor-slot-geometry.v1");

export interface EditorSlotGeometryV1 {
  version: 1;
  width: number;
  bottomMargin: number;
  availableHeight: number;
}

interface EditorSlotResolverV1 {
  version: 1;
  owner: symbol;
  snapshot(tui: TUI): EditorSlotGeometryV1 | undefined;
}

interface EditorSlotRegistryV1 {
  version: 1;
  resolvers: Set<EditorSlotResolverV1>;
}

function registry(): EditorSlotRegistryV1 | undefined {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const existing = globals[EDITOR_SLOT_GEOMETRY_KEY];
  if (existing === undefined) {
    const created: EditorSlotRegistryV1 = { version: 1, resolvers: new Set() };
    globals[EDITOR_SLOT_GEOMETRY_KEY] = created;
    return created;
  }
  if (typeof existing !== "object" || existing === null || (existing as { version?: unknown }).version !== 1) return undefined;
  const compatible = existing as EditorSlotRegistryV1;
  if (!(compatible.resolvers instanceof Set)) compatible.resolvers = new Set();
  return compatible;
}

/** Publish geometry for TUI instances that Pi can replace without rebuilding widgets. */
export function publishEditorSlotGeometryResolver(
  snapshot: (tui: TUI) => EditorSlotGeometryV1 | undefined,
): () => void {
  const shared = registry();
  if (!shared) return () => {};
  const resolver: EditorSlotResolverV1 = {
    version: 1,
    owner: Symbol("pi-claude-style.editor-slot-geometry.owner"),
    snapshot,
  };
  shared.resolvers.add(resolver);
  return () => { shared.resolvers.delete(resolver); };
}

export function resolvePublishedEditorSlotGeometry(tui: TUI): EditorSlotGeometryV1 | undefined {
  const shared = registry();
  if (!shared) return undefined;
  for (const resolver of shared.resolvers) {
    const resolved = resolver.snapshot(tui);
    if (resolved) return resolved;
  }
  return undefined;
}
