import { spawn } from "node:child_process";
import { platform } from "node:os";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function emitOsc52(text: string): boolean {
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

function runClipboardCommand(
  command: string,
  args: readonly string[],
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ok);
    };
    const child = spawn(command, [...args], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5_000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(text);
  });
}

/** Copy without blocking the TUI; remote/opt-in sessions also receive OSC 52. */
export async function copyToClipboard(text: string): Promise<void> {
  const remote = Boolean(
    process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.MOSH_CONNECTION
      || process.env.PI_CLIPBOARD_OSC52 === "1",
  );

  const candidates: Array<readonly [string, readonly string[]]> = platform() === "darwin"
    ? [["pbcopy", []]]
    : platform() === "win32"
    ? [["clip", []]]
    : [
      ...(process.env.TERMUX_VERSION ? [["termux-clipboard-set", []] as const] : []),
      ...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] as const] : []),
      ...(process.env.DISPLAY
        ? [["xclip", ["-selection", "clipboard"]] as const, ["xsel", ["--clipboard", "--input"]] as const]
        : []),
    ];
  let copied = false;
  for (const [command, args] of candidates) {
    if (await runClipboardCommand(command, args, text)) {
      copied = true;
      break;
    }
  }
  // Match Pi: finish the system write before emitting a direct OSC 52 sequence.
  const osc52Emitted = (remote || !copied) && emitOsc52(text);
  if (copied || osc52Emitted) return;
  throw new Error("Failed to copy to clipboard");
}
