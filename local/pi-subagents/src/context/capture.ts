import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MainCaptureOwner } from "./effective.js";

/** Child-only installer. Main reuses its existing lifecycle so its cold graph stays unchanged. */
export function installEffectiveContextCapture(pi: ExtensionAPI, loadRuntime: () => Promise<typeof import("./effective.js")>): void {
  let current: MainCaptureOwner | undefined;
  let runtime: typeof import("./effective.js") | undefined;
  const release = () => { if (current) { current.retired = true; current.captureLease?.retire(); current = undefined; } };
  pi.on("session_start", (_event, ctx) => { release(); current = { sessionId: ctx.sessionManager.getSessionId(), retired: false }; });
  pi.on("context_with_system", async (event, ctx) => {
    const owner = current;
    if (!owner) return;
    runtime ??= await loadRuntime();
    await runtime.observeMainEffectiveRequest(pi, event, ctx, owner);
  });
  pi.on("agent_end", () => { current?.captureLease?.endRequest(); });
  const confirmCapture = (_event: unknown, ctx: ExtensionContext) => {
    if (current && !current.retired && current.sessionId === ctx.sessionManager.getSessionId()) current.captureLease?.confirmRequest(ctx.signal);
  };
  pi.on("before_provider_request", confirmCapture);
  pi.on("after_provider_response", confirmCapture);
  pi.on("session_compact", (_event, ctx) => { runtime?.getEffectiveContextStore().invalidate(ctx.sessionManager.getSessionId(), "native-compaction"); });
  pi.on("session_shutdown", () => { release(); });
}
