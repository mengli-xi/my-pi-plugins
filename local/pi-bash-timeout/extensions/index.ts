import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTimeoutChildFactory } from "./tool.ts";
import { installBashTimeoutChildCapability } from "./subagent-capability.ts";

export default function bashTimeout(pi: ExtensionAPI): void {
  createBashTimeoutChildFactory()(pi);
  const capability = installBashTimeoutChildCapability(dirname(fileURLToPath(import.meta.url)));
  pi.on("session_start", (_event, ctx) => capability.bind(ctx));
  pi.on("session_shutdown", () => capability.dispose());
}
