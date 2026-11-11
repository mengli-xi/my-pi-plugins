import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Deliberately outlive the fixture's injected quit budget; never used by production.
export default function slowQuit(pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => { await new Promise(resolve => setTimeout(resolve, 1_000)); });
}
