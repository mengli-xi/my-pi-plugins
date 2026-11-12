import { installedPiVersion } from "../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Deliberately allowlist the child environment: no credentials or daily Pi settings.
// NODE_OPTIONS carries the caller's offline guard into version probes and Pi children.
export function isolatedEnvironment(directory, extra = {}) {
	const env = {
		PATH: process.env.PATH,
		NODE_OPTIONS: process.env.NODE_OPTIONS,
		HOME: join(directory, "home"),
		PI_CODING_AGENT_DIR: join(directory, "agent"),
		XDG_CONFIG_HOME: join(directory, "config"),
		XDG_CACHE_HOME: join(directory, "cache"),
		XDG_DATA_HOME: join(directory, "data"),
		XDG_STATE_HOME: join(directory, "state"),
		TMPDIR: join(directory, "tmp"),
		TMP: join(directory, "tmp"),
		TEMP: join(directory, "tmp"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	for (const key of [
		"HOME",
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"TMPDIR",
	])
		mkdirSync(env[key], { recursive: true, mode: 0o700 });
	return { ...env, ...extra };
}

export function stockHost(env) {
	const supplied = process.env.PI_GOAL_TEST_BINARY;
	assert.ok(
		supplied && isAbsolute(supplied),
		"Set PI_GOAL_TEST_BINARY to an absolute stock Pi binary path",
	);
	const binary = realpathSync(supplied);
	assert.ok(statSync(binary).isFile(), "PI_GOAL_TEST_BINARY must resolve to an actual file");
	const version = execFileSync(binary, ["--version"], { encoding: "utf8", env }).trim();
	assert.equal(version, installedPiVersion(), "CLI must match the installed SDK");
	return { binary, version };
}
