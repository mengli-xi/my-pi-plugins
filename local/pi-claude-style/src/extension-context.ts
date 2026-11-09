import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export interface ExtensionContextSnapshot {
  hasUI: boolean;
  mode: ExtensionContext["mode"];
  ui?: ExtensionUIContext;
}

/** Snapshot guarded getters before a retiring runner can reclaim UI ownership. */
export function snapshotExtensionContext(
  ctx: ExtensionContext,
): ExtensionContextSnapshot | undefined {
  try {
    const hasUI = ctx.hasUI;
    const mode = ctx.mode;
    return { hasUI, mode, ...(hasUI ? { ui: ctx.ui } : {}) };
  } catch {
    return undefined;
  }
}
