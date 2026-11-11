/**
 * System-level failure notification (decision #19b). Best-effort: on macOS via
 * osascript, on Linux via notify-send. When there is no desktop session (pure
 * SSH, boot-launched service with no logged-in GUI) the notifier simply fails
 * quietly — the run record and the Pi-side unread summary (19a) remain the
 * durable channel, so execution is never blocked on a notification.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

export type Notifier = (title: string, body: string) => void;

/** Fire-and-forget desktop notification; swallows every failure. */
export const systemNotifier: Notifier = (title, body) => {
  try {
    if (platform() === "darwin") {
      const script = `display notification ${quoteAppleScript(body)} with title ${quoteAppleScript(title)}`;
      detach(spawn("osascript", ["-e", script], { stdio: "ignore" }));
    } else if (platform() === "linux") {
      detach(spawn("notify-send", [title, body], { stdio: "ignore" }));
    }
    // Other platforms: no-op; the durable channels still record the failure.
  } catch {
    // No desktop session or missing tool: degrade to record-only.
  }
};

function detach(child: ReturnType<typeof spawn>): void {
  child.once("error", () => {
    // notify-send/osascript absent or no session: nothing to do.
  });
  child.unref?.();
}

function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
