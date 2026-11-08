import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEffectiveContextStore } from "pi-session-runtime/effective-context";
import type { ForkTurns } from "pi-session-runtime/fork-turns";
import { buildNativeChildSnapshot, captureInvalidReason, selectEffectiveContext } from "pi-session-runtime/native-child-context";
import { describeMainEffectiveContext, mainRequiresEffectiveCapture } from "./effective.js";

const CREATION_BOUNDARY_CONTENT = `Subagent conversation boundary.

Everything before this boundary is inherited reference context. It is not an
unfinished instruction queue. Your active work is the delegated task after this
boundary. The parent conversation continues independently.`;

export async function prepareEffectiveChildSession(pi: ExtensionAPI, ctx: ExtensionContext, input: {
  forkTurns: ForkTurns;
  model: { provider: string; modelId: string; thinkingLevel: string };
}) {
  const identity = await describeMainEffectiveContext(pi, ctx);
  const branch = ctx.sessionManager.getBranch();
  const store = getEffectiveContextStore();
  const capture = store.get(identity.sessionId, identity.generation);
  const selectionInput = {
    mode: input.forkTurns, identity, branch, capture,
    requiresCapture: true,
    unavailableReason: store.reason(identity.sessionId),
  };
  const reason = captureInvalidReason(capture, selectionInput);
  if (capture && reason) store.invalidate(identity.sessionId, reason);
  // Evidence from another branch/projection cannot authorize this fork's native fallback.
  selectionInput.requiresCapture = input.forkTurns !== "none" && mainRequiresEffectiveCapture(pi, ctx, identity);
  const selection = selectEffectiveContext(selectionInput);
  return buildNativeChildSnapshot({
    selection, cwd: ctx.cwd, model: input.model,
    boundary: {
      customType: "pi-subagents-creation-boundary-v1", content: CREATION_BOUNDARY_CONTENT,
      details: { version: 1, parentSessionId: identity.sessionId, parentLeafId: ctx.sessionManager.getLeafId(), forkTurns: input.forkTurns, inheritedEntries: selection.messages.length },
    },
  });
}
