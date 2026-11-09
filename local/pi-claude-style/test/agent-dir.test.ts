import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { getAgentDir } from "../src/config/agent-dir.ts";
import { globalStatusLineSettingsPath } from "../src/statusline/config.ts";
import { getStatusLineTranscriptDir } from "../src/statusline/transcript.ts";

test("relative PI_CODING_AGENT_DIR resolves once against the process cwd", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = "tmp/relative-agent";
		const root = resolve("tmp/relative-agent");
		assert.equal(getAgentDir(), root);
		assert.equal(globalStatusLineSettingsPath(), join(root, "settings.json"));
		assert.equal(getStatusLineTranscriptDir(), join(root, "statusline-transcripts"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
