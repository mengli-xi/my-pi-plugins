import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const localModules = realpathSync(join(packageRoot, "../../node_modules"));

for (const dependency of [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]) {
  test(`${dependency} resolves through its package-local dependency entry`, () => {
    // A declared local entry may be a workspace symlink; validate its real target,
    // not a physical node_modules spelling, while still rejecting global fallbacks.
    const localEntry = join(packageRoot, "node_modules", dependency);
    const expectedRoot = `${realpathSync(existsSync(localEntry) ? localEntry : join(localModules, dependency))}${sep}`;
    const resolved = realpathSync(fileURLToPath(import.meta.resolve(dependency)));
    assert.ok(
      resolved.startsWith(expectedRoot),
      `${dependency} escaped its package-local dependency target: ${resolved}`,
    );
    assert.doesNotMatch(resolved, /(?:^|\/)\.nvm\//);
    assert.doesNotMatch(resolved, /\/lib\/node_modules\//);
  });
}
