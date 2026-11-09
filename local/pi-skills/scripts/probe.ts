import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

/** Fallback prototype replacement is a private seam despite the public class. */
export function checkInternals(): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(UserMessageComponent?.prototype, "render");
  const ok = typeof descriptor?.value === "function" && descriptor.writable === true;
  console.error(`${ok ? "OK" : "MISSING"} user-message.render`);
  return ok;
}

export default function probe(pi: { on: (event: string, handler: () => void) => void }): void {
  pi.on("session_start", () => process.exit(checkInternals() ? 0 : 1));
}
