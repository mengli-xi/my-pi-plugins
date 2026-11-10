import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isolatedEnvironment, stockHost } from "./runtime-test-env.mjs";

const output = resolve(process.argv[2] ?? (await mkdtemp(join(tmpdir(), "goal-a1-matrix-"))));
const requested = process.argv.slice(3);
const cases = requested.length
	? requested
	: [
			"normal",
			"no-progress",
			"user-first",
			"user-control-first",
			"budget",
			"budget-end",
			"abort",
			"crash-before-provider",
			"crash-context",
			"crash-after-success",
			"crash-origin",
			"fork-intent",
			"legacy-pending",
			"legacy-queued",
		];
assert.ok(
	cases.every((name) => !name.startsWith("joint-")),
	"Run real joint cases from integration/goal/mailbox-a1-matrix.mjs",
);
const { binary } = stockHost(isolatedEnvironment(join(output, "host")));
const fixture = fileURLToPath(new URL("./mailbox-a1-native.ts", import.meta.url));
const bundle = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
await mkdir(output, { recursive: true });
const summaries = [];
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
		"goal-native-faux",
		"--model",
		"fixture",
		"--thinking",
		"off",
	];
	if (session) args.push("--session", session);
	args.push("-e", fixture);
	const child = spawn(binary, args, {
		cwd: join(directory, "cwd"),
		env: isolatedEnvironment(directory, {
			GOAL_JOINT_LOG: log,
			GOAL_JOINT_SCENARIO: scenario,
			GOAL_JOINT_PHASE: phase,
			GOAL_JOINT_BUNDLE: bundle,
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
	const limits =
		scenario === "no-progress"
			? { automaticTurns: null, noProgressTurns: 2 }
			: scenario === "legacy-pending" ||
					scenario === "fork-intent" ||
					scenario.startsWith("user-") ||
					(scenario.startsWith("crash-") && scenario !== "crash-after-success")
				? { automaticTurns: 1, noProgressTurns: null }
				: { automaticTurns: null, noProgressTurns: null };
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
			experimental: { goals: scenario === "legacy-queued" },
		}),
	);
	let process;
	try {
		let legacySession;
		if (scenario.startsWith("legacy-")) {
			const manager = SessionManager.create(join(directory, "cwd"), join(directory, "sessions"));
			manager.appendMessage({ role: "user", content: "Prior user task", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("Prior response"));
			const id = crypto.randomUUID(),
				now = Date.now();
			manager.appendCustomEntry("goal-state", {
				goal: {
					id,
					text: "Recover the legacy owed continuation",
					status: scenario === "legacy-queued" ? "queued" : "active",
					startedAt: now,
					updatedAt: now,
					iteration: 0,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					baselineTokens: 0,
					automaticModelTurns: 0,
					toolFreeRepeatCount: 0,
				},
				...(scenario === "legacy-pending"
					? {
							pendingContinuation: {
								goalId: id,
								continuationId: `${id}:0:legacy`,
								offerId: "legacy-offer",
								ownerId: "pi-processes",
								logicalKey: "legacy-batch",
								recordedAt: now,
							},
						}
					: {}),
			});
			legacySession = manager.getSessionFile();
		}
		process = await launch(scenario, "run", directory, legacySession);
		await process.until((rows) => rows.some((row) => row.stage === "ready"), "ready");
		if (scenario.startsWith("legacy-")) {
			const cold = (
				await process.until(
					(rows) => rows.some((row) => row.stage === "passive"),
					"legacy passive recovery",
				)
			).findLast((row) => row.stage === "passive");
			assert.equal(cold.calls, 0);
			assert.equal(cold.pending.length, 1);
			assert.equal(cold.bodies, 0);
			assert.equal(cold.sourceIntents.length, 1);
			process.prompt("/mailbox resume");
			const final = (
				await process.until(
					(rows) =>
						rows.some(
							(row) =>
								row.stage === "settled-final" &&
								(scenario === "legacy-queued" ? row.goal === null : row.goal?.status === "paused"),
						),
					"legacy resumed once",
				)
			).findLast((row) => row.stage === "settled-final");
			assert.equal(final.calls, 1);
			assert.equal(final.bodies, 1);
			assert.equal(final.controls, 1);
			if (scenario === "legacy-pending") assert.equal(final.goal.automaticModelTurns, 1);
			summaries.push({
				scenario,
				coldProviderCalls: cold.calls,
				resumedProviderCalls: final.calls,
				bodies: final.bodies,
				controls: final.controls,
				automaticTurns: final.goal?.automaticModelTurns ?? 0,
				passed: true,
			});
			await process.end();
			await writeFile(
				join(output, "summary.json"),
				`${JSON.stringify({ realRequests: 0, results: summaries }, null, 2)}\n`,
			);
			console.log(JSON.stringify(summaries.at(-1)));
			continue;
		}
		process.prompt("AUTHORIZE");
		await process.until(
			(rows) => rows.some((row) => row.stage === "settled-final" && row.kind === "auth"),
			"trusted setup request",
		);
		process.prompt(
			scenario.startsWith("budget")
				? "/goal --tokens 1 summarize safely"
				: "/goal complete the isolated fixture objective",
		);
		if (scenario === "fork-intent") {
			const gate = (
				await process.until(
					(rows) => rows.some((row) => row.stage === "gate"),
					"parent source checkpoint",
				)
			).find((row) => row.stage === "gate");
			await process.kill();
			const fork = SessionManager.forkFrom(
				gate.file,
				join(directory, "cwd"),
				join(directory, "sessions"),
			);
			process = await launch(scenario, "fork", directory, fork.getSessionFile());
			const cold = (
				await process.until(
					(rows) => rows.some((row) => row.stage === "passive"),
					"fork cold inspection",
				)
			).find((row) => row.stage === "passive");
			assert.equal(cold.calls, 0);
			assert.equal(cold.pending.length, 0);
			assert.equal(cold.sourceIntents[0].sourceSessionId, gate.sessionId);
			process.prompt("/mailbox resume");
			process.prompt("/goal-joint-inspect");
			const inspected = (
				await process.until(
					(rows) => rows.some((row) => row.stage === "inspect"),
					"fork resume inspection",
				)
			).findLast((row) => row.stage === "inspect");
			assert.equal(inspected.calls, 0);
			assert.equal(inspected.pending.length, 0);
			assert.equal(inspected.bodies, 0);
			assert.equal(inspected.controls, 0);
			await process.end();
			process = await launch(scenario, "recover", directory, gate.file);
			const parent = (
				await process.until(
					(rows) => rows.some((row) => row.stage === "passive"),
					"parent recovery",
				)
			).find((row) => row.stage === "passive");
			assert.equal(parent.calls, 0);
			assert.equal(parent.pending.length, 1);
			assert.equal(parent.sourceIntents[0].marker, gate.sourceIntents[0].marker);
			process.prompt("/mailbox resume");
			const final = (
				await process.until(
					(rows) =>
						rows.some((row) => row.stage === "settled-final" && row.goal?.status === "paused"),
					"original parent resumed",
				)
			).findLast((row) => row.stage === "settled-final");
			assert.equal(final.calls, 1);
			assert.equal(final.bodies, 1);
			assert.equal(final.controls, 1);
			summaries.push({
				scenario,
				forkColdCalls: cold.calls,
				forkResumedCalls: inspected.calls,
				parentRecoveryCalls: final.calls,
				bodies: final.bodies,
				controls: final.controls,
				passed: true,
			});
		} else if (scenario.startsWith("crash-")) {
			const values = await process.until(
				(rows) => rows.some((row) => row.stage === "gate"),
				"crash gate",
			);
			const gate = values.find((row) => row.stage === "gate");
			const killed = await process.kill();
			assert.equal(killed.signal, "SIGKILL");
			process = await launch(scenario, "recover", directory, gate.file);
			let recovered = await process.until(
				(rows) => rows.some((row) => row.stage === "passive"),
				"cold passive snapshot",
			);
			assert.equal(recovered.filter((row) => row.stage === "request").length, 0);
			if (scenario === "crash-origin") {
				const passive = recovered.findLast((row) => row.stage === "passive");
				assert.equal(gate.pending.length, 0);
				assert.equal(gate.sourceIntents[0].originEntryId, undefined);
				assert.equal(
					passive.pending[0].key,
					`continue:${gate.sourceIntents[0].goalId}:${gate.sourceIntents[0].marker}`,
				);
				assert.equal(passive.pending[0].anchor, gate.sourceIntents[0].anchorEntryId);
			}
			process.prompt("/mailbox resume");
			if (scenario === "crash-after-success") {
				await sleep(500);
				process.prompt("/goal-joint-inspect");
				recovered = await process.until(
					(rows) => rows.some((row) => row.stage === "inspect"),
					"fulfilled replay inspection",
				);
				const final = recovered.findLast((row) => row.stage === "inspect");
				assert.equal(final.calls, 0);
				assert.equal(final.pending.length, 0);
				assert.equal(final.sourceIntents.length, 0);
				assert.equal(final.goal.iteration, gate.goal.iteration);
				assert.equal(final.bodies, 1);
				assert.equal(final.controls, gate.controls);
				summaries.push({
					scenario,
					initialProviderCalls: gate.calls,
					recoveryProviderCalls: 0,
					bodies: final.bodies,
					controls: final.controls,
					terminalReplay: true,
					passed: true,
				});
			} else {
				recovered = await process.until(
					(rows) =>
						rows.some((row) => row.stage === "settled-final" && row.goal?.status === "paused"),
					"one recovered automatic request",
				);
				const final = recovered.findLast((row) => row.stage === "settled-final");
				assert.equal(final.calls, 1);
				assert.equal(final.goal.automaticModelTurns, 1);
				assert.equal(final.bodies, 1);
				assert.equal(final.controls, gate.controls + 1);
				summaries.push({
					scenario,
					initialProviderCalls: gate.calls,
					recoveryProviderCalls: 1,
					bodies: final.bodies,
					controls: final.controls,
					automaticTurns: final.goal.automaticModelTurns,
					passed: true,
				});
			}
		} else if (scenario === "abort") {
			await process.until(
				(rows) => rows.some((row) => row.stage === "request" && row.goalCalls === 2),
				"automatic response to abort",
			);
			process.send("abort");
			await process.until(
				(rows) =>
					rows.some((row) => row.stage === "settled-final" && row.goal?.status === "paused"),
				"aborted Goal pause",
			);
			process.prompt("/mailbox resume");
			await sleep(300);
			assert.equal((await process.rows()).filter((row) => row.stage === "request").length, 3);
			process.prompt("/goal resume");
			const values = await process.until(
				(rows) =>
					rows.some(
						(row) => row.stage === "settled-final" && row.goalCalls === 3 && row.goal === null,
					),
				"explicit Goal resume",
			);
			const requests = values.filter((row) => row.stage === "request" && row.goalId);
			assert.notEqual(requests.at(-1).goalId, requests.at(-2).goalId);
			const final = values.findLast((row) => row.stage === "settled-final");
			summaries.push({
				scenario,
				providerCalls: final.calls,
				bodies: final.bodies,
				controls: final.controls,
				passed: true,
			});
		} else {
			const terminal =
				scenario === "no-progress" || scenario.startsWith("user-")
					? "paused"
					: scenario.startsWith("budget")
						? "budget_limited"
						: null;
			await process.until(
				(rows) =>
					rows.some(
						(row) =>
							row.stage === "settled-final" &&
							(terminal
								? row.goal?.status === terminal &&
									(!scenario.startsWith("user-") || row.calls === 4) &&
									(!scenario.startsWith("budget") || row.bodies >= 1)
								: row.goal === null && row.goalCalls >= 2),
					),
				"terminal scenario state",
			);
			await sleep(300);
			const final = (await process.rows()).findLast((row) => row.stage === "settled-final");
			if (scenario === "normal") {
				assert.equal(final.calls, 3);
				assert.equal(final.bodies, 1);
				assert.equal(final.controls, 1);
			}
			if (scenario === "no-progress") {
				assert.equal(final.calls, 4);
				assert.equal(final.goal.automaticModelTurns, 2);
				assert.equal(final.bodies, 2);
				assert.equal(final.controls, 2);
			}
			if (scenario.startsWith("user-")) {
				assert.equal(final.calls, 4);
				assert.equal(final.goal.automaticModelTurns, 1);
				assert.equal(final.users, 1);
				assert.equal(final.controls, 1);
			}
			if (scenario.startsWith("budget")) {
				assert.equal(final.calls, 3);
				assert.equal(final.bodies, 1);
				const budgetRequests = (await process.rows()).filter(
					(row) => row.stage === "request" && row.goalCalls === 2,
				);
				assert.ok(
					budgetRequests.some((row) =>
						JSON.stringify(row.messages).includes("token budget is exhausted"),
					),
				);
			}
			summaries.push({
				scenario,
				providerCalls: final.calls,
				mainProviderCalls: final.main,
				childProviderCalls: final.child,
				bodies: final.bodies,
				controls: final.controls,
				automaticTurns: final.goal?.automaticModelTurns,
				passed: true,
			});
		}
		await process.end();
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
