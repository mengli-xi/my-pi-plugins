import { retainedBuild } from "../../../scripts/retained-build.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = retainedBuild(root);
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
  const args = ["build", entry, "--outfile", join(build.output, output.slice("dist/".length)), "--target", "bun", "--minify-syntax", "--define", 'PROCESSES_MAIN_ENTRYPOINT="../../index.js"'];
  if (externalPackages) args.push("--packages", "external");
  const result = spawnSync(bun, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

build.publish("index.js", ["createProcessesSideFactory"]);
