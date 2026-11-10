import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runGoalUiE2e } from "../../fork/pi-goal/test/goal-ui-e2e.mjs";

// Cross-plugin loading belongs to this root integration entry, never the
// package's default native PTY run. The caller must supply a real built CC entry.
const supplied = process.env.PI_GOAL_TEST_CC_ENTRY;
assert.ok(
	supplied && isAbsolute(supplied),
	"Set PI_GOAL_TEST_CC_ENTRY to the actual built CC entry",
);
const cc = realpathSync(supplied);
assert.ok(statSync(cc).isFile(), "PI_GOAL_TEST_CC_ENTRY must resolve to a file");
await runGoalUiE2e({ additionalEntries: [cc], semanticGoalRow: true });
