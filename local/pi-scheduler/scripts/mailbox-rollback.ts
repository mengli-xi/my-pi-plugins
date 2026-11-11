#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeSchedulerRollback, schedulerRollbackInventory } from "../src/mailbox-rollback.ts";

const args = process.argv.slice(2);
const locked = args[0] === "--locked";
if (locked) args.shift();
let root: string | undefined;
let archiveDir: string | undefined;
let check = false;
const abandonIds: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--store" && args[i + 1]) root = resolve(args[++i]!);
  else if (a === "--archive" && args[i + 1]) archiveDir = resolve(args[++i]!);
  else if (a === "--abandon" && args[i + 1]) abandonIds.push(args[++i]!);
  else if (a === "--check") check = true;
  else throw new Error(`Unknown or incomplete argument: ${a}`);
}
if (!root || !existsSync(root) || (!check && !archiveDir) || (check && (archiveDir || abandonIds.length))) {
  throw new Error("Usage: node scripts/mailbox-rollback.ts --store <scheduler-dir> --check | --archive <outside-store-dir> [--abandon <exact-injection-id>]...");
}
if (!locked) {
  const invocation = [process.execPath, ...process.execArgv, resolve(process.argv[1]!), "--locked", ...args];
  const result = process.platform === "darwin"
    ? spawnSync("/usr/bin/lockf", ["-k", "-t", "0", resolve(root, "daemon.lock"), ...invocation], { stdio: "inherit" })
    : spawnSync("flock", ["-n", resolve(root, "daemon.lock"), ...invocation], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
if (check) {
  const blockers = schedulerRollbackInventory(root);
  console.log(JSON.stringify({ blockers }, null, 2));
  process.exitCode = blockers.length ? 1 : 0;
} else {
  console.log(JSON.stringify(normalizeSchedulerRollback({ root, archiveDir: archiveDir!, abandonIds }), null, 2));
}
