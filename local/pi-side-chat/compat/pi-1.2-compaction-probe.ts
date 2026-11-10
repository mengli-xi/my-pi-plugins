import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";

/**
 * Side visibility seam: InteractiveMode.addMessageToChat(message, options).
 * A transparent CC dispatcher has different source text. Exercise that same
 * append boundary on an inert receiver, without reading CC's private registry.
 * Probe installation precedes theme/UI initialization: stop the native summary
 * constructor at its public tokensBefore read, before it formats any theme text.
 * Missing/throwing/no-op/changed-role implementations fail closed.
 */
export function checkCompactionAppend(): boolean {
  const append = (InteractiveMode.prototype as unknown as { addMessageToChat?: (this: unknown, message: unknown) => void }).addMessageToChat;
  if (typeof append !== "function") return false;
  const chatContainer = new Container();
  const reachedSummary = {};
  try {
    append.call({ chatContainer, getMarkdownThemeWithSettings: () => ({}), outputPad: 1, toolOutputExpanded: true }, {
      role: "compactionSummary", summary: "SIDE_COMPACTION_PROBE_ONLY",
      get tokensBefore() { throw reachedSummary; },
      firstKeptEntryId: "probe", timestamp: 0,
    });
    return false;
  } catch (error) {
    return error === reachedSummary && chatContainer.children.length === 1 && chatContainer.children[0] instanceof Spacer;
  }
}
