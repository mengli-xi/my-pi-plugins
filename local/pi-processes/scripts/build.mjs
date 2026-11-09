import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });
const bun = process.env.BUN || "bun";
const entries = [
  ["src/index.ts", "dist/index.js", true],
  ["src/ui/manager-view.ts", "dist/manager-view.js", true],
  ["src/child.ts", "dist/child.js", true],
  ["src/child-factory.ts", "dist/child-factory.js", true],
  ["src/supervisor/supervisor-entry.ts", "dist/supervisor.js", false],
  ["src/matchers/matcher-worker-entry.ts", "dist/matcher-worker.js", false],
];
for (const [entry, output, externalPackages] of entries) {
  const args = ["build", entry, "--outfile", output, "--target", "bun", "--minify-syntax"];
  if (externalPackages) args.push("--packages", "external");
  const result = spawnSync(bun, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
