import { InteractiveMode, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { assertProbes, markOk, markBroken, type Probe } from "../internals.ts";
import { checkCompactionAppend } from "./pi-1.2-compaction-probe.ts";

/** Pi 1.5.0 private surfaces (historical filename). Only a Side instance receives these own methods. */
interface VisibilityMode {
  renderSessionEntries(entries: SessionEntry[], options?: { updateFooter?: boolean; populateHistory?: boolean }): void;
  addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
}
const prototype = InteractiveMode.prototype as unknown as VisibilityMode;
export const SIDE_VISIBILITY_PROBES: readonly Probe[] = [
  { id: "side-chat.child.render-session-entries", needs: "InteractiveMode.renderSessionEntries(entries, options)",
    breaks: "Side refuses to open because inherited Main history cannot be safely hidden",
    check: () => {
      const fn = prototype.renderSessionEntries;
      if (typeof fn !== "function") return false;
      let seen = false;
      const entry = { type: "custom", id: "probe", customType: "probe", data: {} };
      const options = { populateHistory: false };
      try {
        // Pi 1.5 forwards entry metadata before options; absent/drifted dispatch refuses the Side view.
        fn.call({ renderSessionItems(items: unknown[], messageMeta: unknown, received: unknown) {
          seen = items.length === 1 && items[0] === entry && messageMeta instanceof Map && messageMeta.size === 0 && received === options;
        } } as unknown as VisibilityMode, [entry] as SessionEntry[], options);
        return seen;
      } catch { return false; }
    } },
  { id: "side-chat.child.compaction-display", needs: "InteractiveMode.addMessageToChat(message, options)",
    breaks: "Side refuses to open because a compaction summary may expose Main history", check: checkCompactionAppend },
];

export function installSideVisibility(mode: InteractiveMode, inherited: ReadonlySet<string>, boundary: string): () => void {
  assertProbes(SIDE_VISIBILITY_PROBES);
  const target = mode as unknown as VisibilityMode;
  const render = target.renderSessionEntries, append = target.addMessageToChat;
  if (typeof render !== "function" || typeof append !== "function") throw new Error("Side visibility instance methods are unavailable");
  const fail = (id: string): never => { markBroken(id, "Unexpected Pi Side rendering call shape"); throw new Error("Side visibility contract changed; refusing to render inherited content"); };
  target.renderSessionEntries = function(entries, options) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.id !== "string" || typeof entry.type !== "string")) return fail(SIDE_VISIBILITY_PROBES[0]!.id);
    return render.call(this, entries.filter(entry => !inherited.has(entry.id) && entry.id !== boundary && entry.type !== "compaction"), options);
  };
  target.addMessageToChat = function(message, options) {
    if (!message || typeof message.role !== "string") return fail(SIDE_VISIBILITY_PROBES[1]!.id);
    if (message.role !== "compactionSummary") append.call(this, message, options);
  };
  for (const probe of SIDE_VISIBILITY_PROBES) markOk(probe.id);
  return () => { target.renderSessionEntries = render; target.addMessageToChat = append; };
}
