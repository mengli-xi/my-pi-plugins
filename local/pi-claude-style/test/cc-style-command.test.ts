import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCcStyleCommand, presentCcStyleResult, registerCcStyleCommand } from "../src/commands/cc-style.ts";
import { ConfigService } from "../src/config/service.ts";
import { CcStyleObservability } from "../src/observability.ts";
import { LifecycleManager } from "../src/lifecycle.ts";

async function withCommand(run: (service: ConfigService, perf: CcStyleObservability) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "cc-style-command-"));
	const service = new ConfigService({ agentDir, env: {} });
	const perf = new CcStyleObservability();
	try { await run(service, perf); } finally { await perf.dispose(); await rm(agentDir, { recursive: true, force: true }); }
}

test("config get/set/reset uses catalog types instead of string-only values", async () => withCommand(async (service, perf) => {
	const set = await executeCcStyleCommand("config set working.refreshMs 240", service, perf);
	assert.match(set.text, /120 → 240/);
	assert.match(set.text, /pending=240/);
	const get = await executeCcStyleCommand("config get working.refreshMs", service, perf);
	assert.match(get.text, /stored=240/);
	const reset = await executeCcStyleCommand("config reset working.refreshMs", service, perf);
	assert.match(reset.text, /240 → 120|120 → 120/);
}));

test("JSON arrays and quoted strings are parsed as values", async () => withCommand(async (service, perf) => {
	await executeCcStyleCommand('config set transcript.nativeToolOutput.tools ["process","task"]', service, perf);
	assert.deepEqual(service.get("transcript.nativeToolOutput.tools").stored, ["process", "task"]);
	await executeCcStyleCommand('config set transcript.userMessages.title "human author"', service, perf);
	assert.equal(service.get("transcript.userMessages.title").stored, "human author");
}));

test("reset-all requires explicit confirmation", async () => withCommand(async (service, perf) => {
	await executeCcStyleCommand("config set features.transcript false", service, perf);
	await assert.rejects(executeCcStyleCommand("config reset-all", service, perf), /requires confirmation/);
	await executeCcStyleCommand("config reset-all", service, perf, { resetAllConfirmed: true });
	assert.equal(service.get("features.transcript").stored, undefined);
}));

test("reset-all --force recovers a degraded store through the command surface", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "cc-style-recover-command-"));
	const directory = join(agentDir, "extensions", "pi-claude-style");
	const path = join(directory, "config.json");
	const bytes = "{ invalid command recovery\n";
	await mkdir(directory, { recursive: true });
	await writeFile(path, bytes);
	const service = new ConfigService({ agentDir, env: {}, now: () => new Date("2026-08-08T02:03:04Z") });
	const perf = new CcStyleObservability();
	try {
		const result = await executeCcStyleCommand("config reset-all --force", service, perf);
		assert.match(result.text, /invalid config backed up/);
		const backup = `${path}.invalid-2026-08-08T02-03-04-000Z.bak`;
		assert.equal(await readFile(backup, "utf8"), bytes);
		assert.equal(service.degradedError, undefined);
	} finally {
		await perf.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("status, doctor, config path, perf, and cache remain independently callable", async () => withCommand(async (service, perf) => {
	assert.match((await executeCcStyleCommand("status", service, perf)).text, /transcript:/);
	assert.match((await executeCcStyleCommand("doctor", service, perf)).text, /schema: v6/);
	assert.equal((await executeCcStyleCommand("config path", service, perf)).text, service.path);
	assert.match((await executeCcStyleCommand("perf", service, perf)).text, /Instrumentation health/);
	const cache = await executeCcStyleCommand("cache", service, perf, {
		cacheHistory: {
			samples: [],
			latest: null,
			summary: {
				requestCount: 0,
				retainedCount: 0,
				totalInputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				significantMissCount: 0,
				significantMissTokens: 0,
			},
		},
	});
	assert.equal(cache.title, "Prompt cache");
	assert.match(cache.text, /Active branch · 0 requests/);
	assert.equal(typeof cache.panel?.renderBody, "function");
}));

test("status and doctor expose lifecycle ownership and feature health", async () => withCommand(async (service, perf) => {
	const lifecycle = new LifecycleManager();
	lifecycle.install({
		id: "statusline",
		install: () => ({ dispose: () => {} }),
		health: () => ({ status: "degraded", detail: "probe failed" }),
	}, undefined);

	const status = await executeCcStyleCommand("status", service, perf, { lifecycle });
	assert.match(status.text, /lifecycle features: statusline/);
	const doctor = await executeCcStyleCommand("doctor", service, perf, { lifecycle });
	assert.match(doctor.text, /WARN feature statusline: degraded — probe failed/);
	await lifecycle.teardownAll();
}));

test("perf switches are live and distinguish the producer from the provider", async () => withCommand(async (service, perf) => {
	const on = await executeCcStyleCommand("perf on", service, perf);
	assert.match(on.text, /producer on/);
	assert.equal(service.get("performance.enabled").pending, undefined);
	const off = await executeCcStyleCommand("perf off", service, perf);
	assert.match(off.text, /provider state is reported separately/);
}));

test("headless commands emit a display message instead of silently returning", async () => {
	const sent: any[] = [];
	await presentCcStyleResult({
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as any, {
		hasUI: false,
		mode: "print",
	} as any, {
		title: "CC Style status",
		text: "transcript: on",
	});
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.display, true);
	assert.match(sent[0].message.content, /CC Style status\ntranscript: on/);
	assert.deepEqual(sent[0].options, { triggerTurn: false });
});

test("headless reset-all explains confirmation and accepts the explicit --yes form", async () => withCommand(async (service, perf) => {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const sent: any[] = [];
	registerCcStyleCommand({
		registerCommand: (name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) => {
			assert.equal(name, "cc-style");
			handler = command.handler;
		},
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as any, service, perf);
	assert.ok(handler);

	await executeCcStyleCommand("config set features.transcript false", service, perf);
	const ctx = { hasUI: false, mode: "print" };
	await handler!("config reset-all", ctx);
	assert.equal(service.get("features.transcript").stored, false, "an unconfirmed headless reset must not mutate the store");
	assert.match(sent.at(-1).message.content, /confirmation is unavailable.*--yes/s);

	await handler!("config reset-all --yes", ctx);
	assert.equal(service.get("features.transcript").stored, undefined);
	assert.match(sent.at(-1).message.content, /all user overrides removed/);
}));


test("config completion derives layout keys, finite values and integer ranges from the catalog", async () => withCommand(async (service, perf) => {
  let command: any;
  registerCcStyleCommand({ registerCommand: (_name: string, value: unknown) => { command = value; } } as any, service, perf);
  const complete = (prefix: string): Array<{ value: string; description?: string }> => command.getArgumentCompletions(prefix);
  const values = (prefix: string) => complete(prefix).map(item => item.value);
  assert.ok(values("").includes("config"));
  assert.ok(values("").includes("config set layout.enabled true"));
  assert.deepEqual(values("config get layout.sticky"), ["config get layout.stickyUserMessage"]);
  assert.deepEqual(values("config set layout.en"), ["config set layout.enabled true", "config set layout.enabled false"]);
  for (const key of ["enabled", "stickyUserMessage", "floatAutocomplete"]) {
    assert.deepEqual(values(`config set layout.${key} `), [`config set layout.${key} true`, `config set layout.${key} false`]);
    assert.deepEqual(values(`config set layout.${key} t`), [`config set layout.${key} true`]);
    assert.deepEqual(values(`config set layout.${key} f`), [`config set layout.${key} false`]);
    assert.deepEqual(values(`config set layout.${key} unknown`), []);
  }
  assert.deepEqual(values("config set loading.mode m"), ["config set loading.mode minimal"]);
  for (const [key, range] of [["popupGap", "0..100"], ["minViewportRows", "1..1000"]]) {
    const result = complete(`config set layout.${key} `);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.value, `config set layout.${key} `);
    assert.ok(result[0]!.description?.includes(`integer ${range}`));
  }
  assert.deepEqual(values("config set layout.unknown"), []);
  assert.deepEqual(values("unknown"), []);
}));
