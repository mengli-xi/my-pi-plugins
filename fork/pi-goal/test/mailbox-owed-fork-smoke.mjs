import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isolatedEnvironment, stockHost } from "./runtime-test-env.mjs";

const output = resolve(process.argv[2] ?? (await mkdtemp(join(tmpdir(), "goal-owed-fork-"))));
const { binary } = stockHost(isolatedEnvironment(join(output, "host")));
const fixture = fileURLToPath(new URL("./mailbox-a1-native.ts", import.meta.url));
const bundle = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

async function launch(directory, scenario, phase, session) {
	const run = join(directory, phase);
	await mkdir(run, { recursive: true });
	const log = join(run, "events.jsonl");
	await writeFile(log, "");
	const child = spawn(
		binary,
		[
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
			"--session",
			session,
			"-e",
			fixture,
		],
		{
			cwd: join(directory, "cwd"),
			env: isolatedEnvironment(directory, {
				GOAL_JOINT_LOG: log,
				GOAL_JOINT_SCENARIO: scenario,
				GOAL_JOINT_PHASE: phase,
				GOAL_JOINT_BUNDLE: bundle,
			}),
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stdout = "",
		stderr = "",
		serial = 0;
	child.stdout.on("data", (data) => (stdout += data));
	child.stderr.on("data", (data) => (stderr += data));
	const exited = new Promise((resolve) =>
		child.on("close", (code, signal) => resolve({ code, signal })),
	);
	const prompt = (message) => {
		const id = ++serial;
		child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
		return id;
	};
	const rows = async () =>
		(await readFile(log, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
	const until = async (predicate, label) => {
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			const records = await rows();
			if (predicate(records)) return records;
			if (child.exitCode !== null || child.signalCode !== null) break;
			await delay(20);
		}
		throw new Error(`${scenario}/${phase}: ${label}; ${stderr}; ${stdout.slice(-1200)}`);
	};
	const save = async () => {
		await writeFile(join(run, "rpc.jsonl"), stdout);
		await writeFile(join(run, "stderr.log"), stderr);
	};
	return {
		child,
		prompt,
		rows,
		until,
		async command(message) {
			const id = prompt(message);
			await until(
				() =>
					stdout.split("\n").some((line) => {
						try {
							const row = JSON.parse(line);
							return row.type === "response" && row.id === id && row.success === true;
						} catch {
							return false;
						}
					}),
				"command completed",
			);
		},
		async kill() {
			child.kill("SIGKILL");
			const result = await exited;
			await save();
			assert.equal(result.signal, "SIGKILL");
		},
		async end() {
			child.stdin.end();
			let timer;
			const result = await Promise.race([
				exited,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("Pi shutdown timeout")), 15000);
				}),
			]).finally(() => clearTimeout(timer));
			await save();
			assert.equal(result.code, 0, JSON.stringify(result));
			assert.ok(!stdout.includes('"type":"extension_error"'));
		},
		async inspect() {
			const count = (await rows()).filter((row) => row.stage === "inspect").length;
			prompt("/goal-joint-inspect");
			return (
				await until(
					(records) => records.filter((row) => row.stage === "inspect").length > count,
					"inspection",
				)
			).findLast((row) => row.stage === "inspect");
		},
		async terminal(file, key) {
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const lines = (await readFile(file, "utf8")).split("\n");
				lines.pop();
				for (const entry of lines.filter(Boolean).map(JSON.parse)) {
					if (entry.type !== "custom" || entry.customType !== "agent-mailbox-delivery-v1") continue;
					const terminal = entry.data.terminals.find((record) => record.evidence.key === key);
					if (terminal) return terminal.evidence;
				}
				await delay(20);
			}
			throw new Error("Expected original-key durable delivery receipt");
		},
	};
}

const results = [];
for (const action of ["resume", "clear"]) {
	const scenario = `own-fork-owed-${action}`,
		directory = join(output, scenario);
	for (const folder of ["home", "agent", "cwd", "tmp", "sessions"])
		await mkdir(join(directory, folder), { recursive: true, mode: 0o700 });
	await writeFile(
		join(directory, "agent/settings.json"),
		JSON.stringify({
			packages: [],
			extensions: [],
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	await writeFile(
		join(directory, "agent/pi-goal.json"),
		JSON.stringify({ continuationLimits: { automaticTurns: 1, noProgressTurns: null } }),
	);
	const root = SessionManager.create(join(directory, "cwd"), join(directory, "sessions"));
	root.appendMessage({ role: "user", content: "Root has no Goal", timestamp: Date.now() });
	root.appendMessage(fauxAssistantMessage("Root response"));
	const owner = SessionManager.forkFrom(
		root.getSessionFile(),
		join(directory, "cwd"),
		join(directory, "sessions"),
	);
	let running;
	try {
		running = await launch(directory, scenario, "run", owner.getSessionFile());
		await running.until((rows) => rows.some((row) => row.stage === "ready"), "ready");
		running.prompt("AUTHORIZE");
		await running.until(
			(rows) => rows.some((row) => row.stage === "settled-final" && row.kind === "auth"),
			"setup request settled",
		);
		running.prompt("/goal local work created after fork");
		await running.until(
			(rows) => rows.some((row) => row.stage === "settled-final" && row.goalCalls === 1),
			"local Goal waiting",
		);
		running.prompt("/goal-fixture-commit-owed");
		const gate = (
			await running.until((rows) => rows.some((row) => row.stage === "gate"), "committed receipt")
		).find((row) => row.stage === "gate");
		await running.kill();
		assert.equal(gate.owed.sourceSessionId, owner.getSessionId());
		assert.equal(gate.obligation, "owed");
		assert.equal(gate.receipt.continuationId, gate.owed.continuationId);
		assert.equal(gate.sourceIntents.length, 0);
		assert.equal(gate.pending.length, 0);
		const key = `continue:${gate.owed.goalId}:${gate.owed.continuationId}`;

		const descendant = SessionManager.forkFrom(
			gate.file,
			join(directory, "cwd"),
			join(directory, "sessions"),
		);
		running = await launch(directory, scenario, "descendant", descendant.getSessionFile());
		const inherited = (
			await running.until(
				(rows) => rows.some((row) => row.stage === "passive"),
				"descendant cold hold",
			)
		).findLast((row) => row.stage === "passive");
		assert.equal(inherited.calls, 0);
		assert.equal(inherited.obligation, "none");
		assert.equal(inherited.pending.length, 0);
		running.prompt("/mailbox resume");
		const descendantFinal = await running.inspect();
		assert.equal(descendantFinal.calls, 0);
		assert.equal(descendantFinal.pending.length, 0);
		assert.equal(descendantFinal.sourceIntents.length, 0);
		assert.equal(descendantFinal.bodies, 0);
		assert.equal(descendantFinal.controls, 0);
		await running.end();

		running = await launch(directory, scenario, "recover", gate.file);
		const cold = (
			await running.until(
				(rows) => rows.some((row) => row.stage === "passive"),
				"original fork cold hold",
			)
		).findLast((row) => row.stage === "passive");
		assert.equal(cold.calls, 0);
		assert.equal(cold.obligation, "owed");
		assert.equal(cold.pending[0].key, key);
		assert.equal(cold.sourceIntents[0].sourceSessionId, owner.getSessionId());
		let final;
		if (action === "resume") {
			running.prompt("/mailbox resume");
			final = (
				await running.until(
					(rows) =>
						rows.some((row) => row.stage === "settled-final" && row.goal?.status === "paused"),
					"one resumed continuation",
				)
			).findLast((row) => row.stage === "settled-final");
			assert.equal(final.calls, 1);
			assert.equal(final.bodies, 1);
			assert.equal(final.controls, 1);
			assert.equal(final.goal.automaticModelTurns, 1);
			assert.equal(final.obligation, "none");
			assert.equal(final.pending.length, 0);
			const requests = (await running.rows()).filter((row) => row.stage === "request");
			assert.equal(requests.length, 1);
			assert.ok(JSON.stringify(requests[0].messages).includes(gate.owed.continuationId));
		} else {
			await running.command("/goal clear");
			final = await running.inspect();
			assert.equal(final.calls, 0);
			assert.equal(final.goal, null);
			assert.equal(final.pending.length, 0);
			assert.equal(final.owed, null);
			assert.equal(final.sourceIntents.length, 0);
			assert.equal(final.bodies, 0);
			assert.equal(final.controls, 0);
		}
		const terminal = await running.terminal(final.file, key);
		assert.equal(terminal.scope.sessionId, owner.getSessionId());
		if (action === "clear") assert.equal(terminal.outcome, "cancelled");
		await running.end();
		results.push({
			scenario,
			producerReceipt: true,
			sourceSessionId: owner.getSessionId(),
			key,
			descendantCalls: descendantFinal.calls,
			coldCalls: cold.calls,
			recoveryCalls: final.calls,
			bodies: final.bodies,
			controls: final.controls,
			passed: true,
		});
	} catch (error) {
		if (running && running.child.exitCode === null && running.child.signalCode === null)
			await running.kill();
		results.push({ scenario, passed: false, error: String(error) });
	}
	await writeFile(
		join(output, "summary.json"),
		`${JSON.stringify({ realRequests: 0, results }, null, 2)}\n`,
	);
	console.log(JSON.stringify(results.at(-1)));
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
