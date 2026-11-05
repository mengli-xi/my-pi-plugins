import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionNamingConfigService } from "./config.ts";
import { SessionNamingController } from "./naming.ts";

export { SessionNamingConfigService } from "./config.ts";
export { sanitizeName, SessionNamingController } from "./naming.ts";
export { SessionNamingTelemetry } from "./telemetry.ts";

export default function register(pi: ExtensionAPI): void {
  const service = new SessionNamingConfigService();
  let warnedDegraded = false;
  pi.on("session_start", (_event, ctx) => {
    if (!warnedDegraded && service.degradedError !== undefined) {
      warnedDegraded = true;
      const message = `Automatic session naming disabled: ${service.degradedError}`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(message);
    }
  });
  new SessionNamingController(pi, () => service.active).install();
}
