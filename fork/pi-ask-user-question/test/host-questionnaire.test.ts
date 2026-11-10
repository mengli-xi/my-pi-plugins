import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Pi 1.5 faux host drives real questionnaire UI and noninteractive exposure without human input", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ask-host-"));
	for (const name of ["home", "agent", "config", "cwd"]) mkdirSync(join(root, name));
	try {
		execFileSync(process.execPath, ["test/fixtures/host-questionnaire.mjs"], {
			cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 60_000,
			env: { PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
				XDG_CONFIG_HOME: join(root, "config"), FORK15_TEST_ROOT: root, TERM: "xterm-256color", PI_OFFLINE: "1" },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
