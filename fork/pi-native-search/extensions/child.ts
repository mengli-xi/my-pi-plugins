/** Stable capability descriptor target for the explicit SDK factory. */
export { createSearchChildFactory, loadSearchConfig } from "./index.ts";
export type { SearchConfigSnapshot, SearchBackendOptions, SearchBackendEvents, SearchBackendV1 } from "./index.ts";

import { createSearchChildFactory, loadSearchConfig } from "./index.ts";
export function createRegisteredSearchChildFactory(options: { agentDir: string; backendEvents?: import("@earendil-works/pi-coding-agent").ExtensionAPI["events"] }) {
  return createSearchChildFactory(loadSearchConfig(options.agentDir), { backendEvents: options.backendEvents });
}
