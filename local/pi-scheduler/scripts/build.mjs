import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Bundle the daemon entry to plain JS so a real node/bun runtime (not the Pi
// binary) can run it under launchd/systemd. Everything the daemon needs is
// bundled; there are no runtime peer deps for the standalone process.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, "dist"), { recursive: true });
const bun = process.env.BUN || "bun";
const result = spawnSync(
  bun,
  ["build", "src/daemon-entry.ts", "--outfile", "dist/daemon.js", "--target", "node", "--minify-syntax"],
  { cwd: root, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("built dist/daemon.js");
