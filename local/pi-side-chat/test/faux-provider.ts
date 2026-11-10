import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

/** Offline response used by the stock-host visibility probe. */
export default function probeProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "side-faux", api: "side-faux",
    models: [{ id: "side-faux-1", contextWindow: 128_000, maxTokens: 1024 }] });
  faux.setResponses([fauxAssistantMessage("SIDE_PROBES_COMPLETE")]);
  pi.registerProvider(faux.provider);
}
