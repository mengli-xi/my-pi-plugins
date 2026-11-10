import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { captureEntrypointDescriptorV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import {
	isolatedEnvironment,
	stockHost,
} from "../../fork/pi-goal/test/runtime-test-env.mjs";

const output = resolve(process.argv[2] ?? (await mkdtemp(join(tmpdir(), "goal-joint-matrix-"))));
const allowedCases = ["joint-b", "joint-bd", "joint-grant", "joint-paused", "joint-paused-split"];
const requested = process.argv.slice(3);
const cases = requested.length ? requested : allowedCases;
assert.ok(cases.every((name) => allowedCases.includes(name)), "Unknown Goal joint matrix case");
const { binary } = stockHost(isolatedEnvironment(join(output, "host")));
const fixture = fileURLToPath(new URL("./mailbox-a1-native.ts", import.meta.url));
const bundle = fileURLToPath(
	new URL("../../fork/pi-goal/dist/index.js", import.meta.url),
);
const workspace = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
await mkdir(output, { recursive: true });
const summaries = [];
function jointProviderManifest(child) {
	return {
		version: 1,
		owner_id: "goal-joint-faux",
		main_entrypoint: captureEntrypointDescriptorV1(fixture),
		targets: {
			"pi-subagents": {
				child_entrypoint: captureEntrypointDescriptorV1(child),
				activation: "required-only",
				commands: [],
				tools: [],
				providers: [
					{ provider_id: "goal-joint-faux", service_tiers: [], service_tier_application: "none" },
				],
				hooks: [],
				requires: [],
				sdk_provider_factory: {
					provider_id: "goal-joint-faux",
					package_manifest: captureEntrypointDescriptorV1(join(child, "../../package.json")),
					module: captureEntrypointDescriptorV1(join(child, "../child-factory.ts")),
					export: "createGoalChildFactory",
					config: {},
					artifacts: [
						captureEntrypointDescriptorV1(
							fileURLToPath(new URL("./mailbox-a1-barriers.ts", import.meta.url)),
						),
						captureEntrypointDescriptorV1(fixture),
					],
				},
			},
		},
	};
}
async function auditJoint(process, scenario) {
	const expected = {
		"joint-b": [5, 5, 0, 1, 1, 1, 0],
		"joint-bd": [7, 6, 1, 2, 2, 1, 1],
		"joint-grant": [7, 4, 3, 1, 1, 0, 1],
		"joint-paused": [5, 4, 1, 0, 1, 1, 1],
		"joint-paused-split": [6, 5, 1, 0, 2, 1, 1],
	}[scenario];
	assert.ok(expected, `Missing strict expectation: ${scenario}`);
	const rows = await process.rows(),
		final = rows.findLast((row) => row.stage === "inspect");
	assert.deepEqual(
		[
			final.calls,
			final.main,
			final.child,
			final.bodies,
			final.controls,
			final.processBodies,
			final.completions,
		],
		expected,
	);
	const requests = rows.filter((row) => row.stage === "request");
	assert.equal(requests.length, expected[0]);
	assert.equal(requests.filter((row) => row.kind === "child").length, expected[2]);
	assert.equal(final.pending.length, 0);
	const entries = (await readFile(final.file, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
	const count = (type) =>
		entries.filter((entry) => entry.type === "custom_message" && entry.customType === type).length;
	assert.deepEqual(
		[
			count("goal-mailbox-continuation-v1"),
			count("agent-mailbox-trigger-v1"),
			count("process-notification-batch-v1"),
			count("subagent-completion-v1"),
		],
		expected.slice(3),
	);
	assert.equal(count("subagent-continuation-v1"), scenario.startsWith("joint-paused") ? 1 : 0);
	const controls = entries.filter(
		(entry) => entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1",
	);
	assert.equal(controls.length, expected[4]);
	assert.equal(new Set(controls.map((entry) => entry.details.attemptId)).size, controls.length);
	const seen = new Set(),
		attempts = [];
	for (const control of controls) {
		const attempt = entries.find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "agent-mailbox-attempt-v1" &&
				entry.data.id === control.details.attemptId,
		)?.data;
		assert.equal(attempt?.sessionId, final.sessionId);
		assert.ok(attempt.members.length > 0);
		for (const member of attempt.members) {
			const key = JSON.stringify([member.producer, member.key, member.anchorEntryId]);
			assert.equal(seen.has(key), false, `member reused by two controls: ${key}`);
			seen.add(key);
		}
		attempts.push(attempt.members);
	}
	const producers = attempts.map((members) =>
		[...new Set(members.map((member) => member.producer))].sort(),
	);
	if (scenario === "joint-paused") assert.deepEqual(producers, [["pi-processes", "pi-subagents"]]);
	if (scenario === "joint-paused-split")
		assert.deepEqual(producers, [["pi-processes"], ["pi-subagents"]]);
	if (scenario === "joint-b") assert.deepEqual(producers, [["pi-goal", "pi-processes"]]);
	if (scenario === "joint-bd")
		assert.deepEqual(producers, [
			["pi-goal", "pi-subagents"],
			["pi-goal", "pi-processes"],
		]);
	if (scenario === "joint-grant") assert.deepEqual(producers, [["pi-goal", "pi-subagents"]]);
	for (const entry of entries.filter(
		(entry) => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1",
	)) {
		for (const terminal of entry.data.terminals.filter(
			(item) => item.evidence.outcome === "fulfilled",
		)) {
			for (const message of terminal.mail.messages) {
				const matches = entries.filter(
					(body) =>
						body.type === "custom_message" &&
						body.customType === message.customType &&
						isDeepStrictEqual(body.content, message.content) &&
						isDeepStrictEqual(body.details, message.details) &&
						(body.display ?? false) === (message.display ?? false),
				);
				assert.equal(
					matches.length,
					1,
					`canonical body uniqueness: ${terminal.mail.producer}/${terminal.mail.key}`,
				);
			}
		}
	}
	return attempts;
}
async function launch(scenario, phase, directory, session) {
	const phaseDir = join(directory, phase);
	await mkdir(phaseDir, { recursive: true });
	const log = join(phaseDir, "events.jsonl");
	await writeFile(log, "");
	const args = [
		"--mode",
		"rpc",
		"--offline",
		"--approve",
		"-ne",
		"--no-mcp",
		"-ns",
		"-np",
		"-nc",
		"--no-themes",
		"--provider",
		"goal-joint-faux",
		"--model",
		"fixture",
		"--thinking",
		"off",
	];
	if (session) args.push("--session", session);
	const extraEnv = {};
	if (scenario.startsWith("joint-")) {
		args.push("-e", fileURLToPath(new URL("./mailbox-a1-wake-gate.ts", import.meta.url)));
		const b = join(workspace, "local/pi-processes/dist/index.js"),
			d = join(workspace, "local/pi-subagents/dist/index.js");
		const extras = scenario === "joint-b" ? [b] : [b, d];
		const ordered =
			process.env.GOAL_JOINT_REVERSE === "1"
				? [fixture, ...extras.reverse()]
				: [...extras, fixture];
		args.push(...ordered.flatMap((path) => ["-e", path]));
		if (scenario !== "joint-b") {
			const pkg = join(directory, "faux-goal-provider");
			await mkdir(join(pkg, "src"), { recursive: true });
			await writeFile(
				join(pkg, "package.json"),
				JSON.stringify({ name: "goal-joint-fixture-provider", type: "module" }),
			);
			const child = join(pkg, "src/child.ts");
			await writeFile(child, "// Frozen SDK provider capability target.\n");
			await writeFile(
				join(pkg, "src/child-factory.ts"),
				`export function createGoalChildFactory() { return async pi => { const fixture = await import(${JSON.stringify(new URL("./mailbox-a1-native.ts", import.meta.url).href)}); fixture.installJointProvider(pi); }; }\n`,
			);
			const manifest = jointProviderManifest(child);
			await writeFile(
				join(directory, "agent/sdk-provider-grants.json"),
				JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(manifest, "pi-subagents")] }),
				{ mode: 0o600 },
			);
			extraEnv.GOAL_JOINT_FAUX_CHILD = child;
		}
	} else args.push("-e", fixture);
	const child = spawn(binary, args, {
		cwd: join(directory, "cwd"),
		env: isolatedEnvironment(directory, {
			GOAL_JOINT_LOG: log,
			GOAL_JOINT_BARRIER_DIR: join(directory, "barriers"),
			GOAL_JOINT_SCENARIO: scenario,
			GOAL_JOINT_PHASE: phase,
			GOAL_JOINT_BUNDLE: bundle,
			...extraEnv,
		}),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (data) => (stdout += data));
	child.stderr.on("data", (data) => (stderr += data));
	const exit = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
	let serial = 0;
	const send = (type, rest = {}) =>
		child.stdin.write(`${JSON.stringify({ id: `${phase}-${++serial}`, type, ...rest })}\n`);
	const prompt = (message) => send("prompt", { message });
	const rows = async () =>
		(await readFile(log, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
	const until = async (predicate, label) => {
		const end = Date.now() + 30000;
		while (Date.now() < end) {
			const values = await rows();
			if (predicate(values)) return values;
			if (child.exitCode !== null) break;
			await sleep(20);
		}
		throw Error(`${scenario}/${phase}: timeout ${label}; ${stderr}; ${stdout.slice(-1200)}`);
	};
	const save = async () => {
		await writeFile(join(phaseDir, "rpc.jsonl"), stdout);
		await writeFile(join(phaseDir, "stderr.log"), stderr);
	};
	return {
		child,
		send,
		prompt,
		rows,
		until,
		exit,
		save,
		async end() {
			child.stdin.end();
			const result = await Promise.race([exit, sleep(10000).then(() => ({ timeout: true }))]);
			if (result.timeout) child.kill("SIGKILL");
			await save();
			assert.equal(result.code, 0, JSON.stringify(result));
			assert.ok(
				!stdout.includes('"type":"extension_error"'),
				stdout
					.split("\n")
					.filter((line) => line.includes('"type":"extension_error"'))
					.join("\n"),
			);
			return result;
		},
		async kill() {
			child.kill("SIGKILL");
			const result = await exit;
			await save();
			return result;
		},
	};
}
for (const scenario of cases) {
	const directory = join(output, scenario);
	for (const name of ["home", "agent", "cwd", "tmp", "barriers"])
		await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
	const limits = { automaticTurns: null, noProgressTurns: null };
	await writeFile(
		join(directory, "agent/settings.json"),
		JSON.stringify({
			retry: { enabled: false },
			compaction: { enabled: false },
			packages: [],
			extensions: [],
		}),
	);
	await writeFile(
		join(directory, "agent/pi-goal.json"),
		JSON.stringify({
			continuationLimits: limits,
			experimental: { goals: false },
		}),
	);
	await mkdir(join(directory, "agent/pi-subagents"), { recursive: true, mode: 0o700 });
	await writeFile(
		join(directory, "agent/pi-subagents/config.json"),
		JSON.stringify({ schemaVersion: 2, execution: { maxDepth: 1 } }),
	);
	let process;
	try {
		process = await launch(scenario, "run", directory);
		await process.until((rows) => rows.some((row) => row.stage === "ready"), "ready");
		process.prompt("AUTHORIZE");
		await process.until(
			(rows) => rows.some((row) => row.stage === "settled-final" && row.kind === "auth"),
			"trusted setup request",
		);
		process.prompt(
			"/goal complete the isolated fixture objective",
		);
		if (scenario.startsWith("joint-")) {
			const release = (name) => writeFile(join(directory, "barriers", name), "release");
			const received = (predicate) =>
				process.until(
					(rows) => rows.some((row) => row.stage === "observe" && predicate(row)),
					"received and recorded joint members",
				);
			await process.until(
				(rows) => rows.some((row) => row.stage === "settled-final" && row.goalCalls === 2),
				"initial Main run settled",
			);
			const initialRequest = (await process.rows()).findLast(
				(row) => row.stage === "request" && row.kind !== "child" && row.goalCalls === 2,
			);
			for (const message of initialRequest?.messages ?? []) {
				if (message.role !== "toolResult") continue;
				assert.equal(
					message.isError ?? false,
					false,
					`joint fixture tool failed: ${JSON.stringify(message.content)}`,
				);
				assert.ok(
					!JSON.stringify(message.content).includes("[process/helper-runtime-unavailable]"),
					`Process runtime prerequisite failed: ${JSON.stringify(message.content)}`,
				);
			}
			if (scenario.startsWith("joint-paused")) {
				process.prompt("/goal pause");
				await process.until(
					(rows) => rows.some((row) => row.stage === "observe" && row.goal?.status === "paused"),
					"explicit paused Goal",
				);
				await release("process");
				if (scenario === "joint-paused-split") {
					await received(
						(row) =>
							row.processBodies === 1 &&
							row.pending.length > 0 &&
							row.pending.every((item) => item.recorded),
					);
					await release("wake-open");
					process.prompt("/mailbox resume");
					await process.until(
						(rows) =>
							rows.some(
								(row) =>
									row.stage === "settled-final" && row.controls === 1 && row.completions === 0,
							),
						"first disjoint cutoff settled",
					);
				}
				await release("child");
				await received(
					(row) =>
						row.processBodies === 1 &&
						row.completions === 1 &&
						row.fallbacks === 1 &&
						row.pending.every((item) => item.recorded),
				);
			} else if (scenario === "joint-b") {
				await release("process");
				await received(
					(row) =>
						row.processBodies === 1 &&
						row.bodies === 1 &&
						row.pending.every((item) => item.recorded),
				);
			} else if (scenario === "joint-bd") {
				await release("child");
				await received(
					(row) =>
						row.completions === 1 && row.bodies === 1 && row.pending.every((item) => item.recorded),
				);
				await release("wake-open");
				process.prompt("/mailbox resume");
				await process.until(
					(rows) =>
						rows.some(
							(row) => row.stage === "settled-final" && row.controls === 1 && row.goalCalls === 3,
						),
					"first D/Goal cutoff settled",
				);
				await release("process");
				await received(
					(row) =>
						row.processBodies === 1 &&
						row.bodies === 2 &&
						row.pending.every((item) => item.recorded),
				);
			} else if (scenario === "joint-grant") {
				await process.until(
					(rows) => rows.some((row) => row.stage === "child-settled" && row.child === 2),
					"child parked after Process wait",
				);
				await release("child-process");
				await received(
					(row) =>
						row.completions === 1 && row.bodies === 1 && row.pending.every((item) => item.recorded),
				);
			}
			await release("wake-open");
			process.prompt("/mailbox resume");
		}
		if (scenario.startsWith("joint-paused")) {
			await process.until(
				(rows) => rows.some((row) => row.stage === "settled-final" && row.goalCalls === 2),
				"Process wait and child started",
			);
			process.prompt("/goal pause");
			const values = await process.until(
				(rows) =>
					rows.some(
						(row) =>
							row.stage === "settled-final" &&
							row.goal?.status === "paused" &&
							row.processBodies === 1 &&
							row.completions === 1,
					),
				"paused Goal background results",
			);
			const final = values.findLast((row) => row.stage === "settled-final");
			assert.equal(final.goal.status, "paused");
			assert.equal(final.goal.automaticModelTurns, 0);
			assert.equal(final.bodies, 0);
			assert.equal(final.child, 1);
			assert.equal(final.controls, scenario === "joint-paused-split" ? 2 : 1);
			assert.equal(final.main, scenario === "joint-paused-split" ? 5 : 4);
			assert.equal(final.calls, scenario === "joint-paused-split" ? 6 : 5);
			summaries.push({
				scenario,
				providerCalls: final.calls,
				mainProviderCalls: final.main,
				childProviderCalls: final.child,
				bodies: final.bodies,
				controls: final.controls,
				processBodies: final.processBodies,
				completions: final.completions,
				automaticTurns: final.goal.automaticModelTurns,
				owed: final.owed,
				passed: true,
			});
		} else {
			await process.until(
				(rows) =>
					rows.some(
						(row) => row.stage === "settled-final" && row.goal === null && row.goalCalls >= 2,
					),
				"terminal scenario state",
			);
			await sleep(300);
			const final = (await process.rows()).findLast((row) => row.stage === "settled-final");
			if (scenario === "joint-grant") {
				assert.equal(final.child, 3);
				assert.equal(final.completions, 1);
				const resumed = (await process.rows()).find(
					(row) => row.stage === "request" && row.kind === "child" && row.child === 3,
				);
				assert.ok(JSON.stringify(resumed?.messages).includes("Background process updates:"));
				const childEntries = (await readFile(resumed.sessionFile, "utf8"))
					.split("\n")
					.filter(Boolean)
					.map(JSON.parse);
				assert.equal(
					childEntries.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "process-notification-batch-v1",
					).length,
					1,
				);
				assert.equal(
					childEntries.filter(
						(entry) =>
							entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1",
					).length,
					1,
				);
			}
			summaries.push({
				scenario,
				providerCalls: final.calls,
				mainProviderCalls: final.main,
				childProviderCalls: final.child,
				bodies: final.bodies,
				controls: final.controls,
				processBodies: final.processBodies,
				completions: final.completions,
				automaticTurns: final.goal?.automaticModelTurns,
				passed: true,
			});
		}
		if (scenario.startsWith("joint-")) {
			await writeFile(join(directory, "barriers", "wake-open"), "final empty reconcile");
			process.prompt("/mailbox resume");
			process.prompt("/goal-joint-inspect");
			await process.until(
				(rows) => rows.some((row) => row.stage === "inspect"),
				"final empty admission check",
			);
		}
		await process.end();
		if (scenario.startsWith("joint-"))
			summaries.at(-1).attempts = await auditJoint(process, scenario);
	} catch (error) {
		if (process && process.child.exitCode === null) await process.kill();
		if (summaries.at(-1)?.scenario === scenario && summaries.at(-1).passed) summaries.pop();
		summaries.push({ scenario, passed: false, error: String(error) });
	}
	await writeFile(
		join(output, "summary.json"),
		`${JSON.stringify({ realRequests: 0, results: summaries }, null, 2)}\n`,
	);
	console.log(JSON.stringify(summaries.at(-1)));
}
if (summaries.some((result) => !result.passed)) process.exitCode = 1;
