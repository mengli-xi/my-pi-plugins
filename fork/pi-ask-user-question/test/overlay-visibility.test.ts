import { execFileSync } from "node:child_process";
import test from "node:test";

test("real Pi TUI yields to dialogs and restores ask across input, nesting, abort, timeout and manual collapse", () => {
	// Run outside ts-resolve's peer doubles: this pins actual public focus and
	// visibility behavior in both stock Pi renderers, including keyboard routing.
	execFileSync(process.execPath, ["--experimental-strip-types", "test/fixtures/overlay-focus.mjs"], {
		cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000,
	});
});
