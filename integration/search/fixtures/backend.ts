import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SEARCH_BACKENDS_REQUEST_V1 } from "../../../fork/pi-native-search/extensions/index.ts";

export const BACKEND_CONTROLS = Symbol.for("search-integration.backend-controls");
export interface BackendControl {
  label: string;
  available: boolean;
  calls: Array<{ query: string; session: string; provider?: string }>;
  events?: ExtensionAPI["events"];
}

/** A versioned collaborator, not a native-provider or credentials replacement. */
export default function backend(pi: ExtensionAPI) {
  const controls = (globalThis as any)[BACKEND_CONTROLS] as Map<string, BackendControl>;
  const control = controls.get(getAgentDir());
  if (!control) throw new Error("Missing isolated backend fixture control");
  control.events = pi.events;
  const unsubscribe = pi.events.on(SEARCH_BACKENDS_REQUEST_V1, (request: any) => {
    if (!control.available) return;
    request.contribute({ version: 1, id: "fixture-search", label: control.label, defaultProviders: ["search-faux"],
      async search({ query, ctx }: any) {
        control.calls.push({ query, session: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider });
        return `${control.label}: ${query}`;
      },
    });
  });
  pi.on("session_shutdown", () => unsubscribe());
}
