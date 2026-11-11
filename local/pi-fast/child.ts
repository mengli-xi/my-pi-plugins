import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyFastTier } from "./state.ts";

/** Frozen parent state only; no commands, global writes or parent override entries. */
export function createFastChildFactory(options: { context: Readonly<Record<string, unknown>> }) {
  const enabled = options.context.enabled;
  if (typeof enabled !== "boolean") throw new Error("fast child context.enabled must be boolean");
  return (pi: ExtensionAPI): void => {
    pi.on("before_provider_request", (event, ctx) => applyFastTier(event.payload, ctx.model?.provider, enabled));
  };
}
