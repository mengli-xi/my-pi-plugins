import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindTerminalFocus, releaseTerminalFocus } from "./cursor.ts";

export default function terminalFocus(pi: ExtensionAPI): void {
  const owner = {};
  const bind = (_event: unknown, ctx: ExtensionContext): void => bindTerminalFocus(owner, ctx);

  pi.on("session_start", bind);
  pi.on("resources_discover", bind);
  pi.on("session_shutdown", () => releaseTerminalFocus(owner));
}
