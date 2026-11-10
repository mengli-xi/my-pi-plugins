import assert from "node:assert/strict";
import test from "node:test";
import { completeGoalArguments, parseCommand } from "../src/command.js";

const QUEUE_FEATURE = { experimentalGoals: true } as const;

test("default command parsing keeps queue words inside ordinary objectives", () => {
	for (const objective of [
		"add docs",
		"prioritize outage",
		"drop-last",
		"skip",
		"push docs",
		"unshift outage",
		"pop",
		"shift",
	]) {
		assert.deepEqual(parseCommand(objective), {
			kind: "start",
			objective,
			tokenBudget: undefined,
		});
	}

	const completions = completeGoalArguments("") ?? [];
	assert.equal(
		completions.some(({ label }) => label === "add"),
		false,
	);
	assert.equal(
		completions.some(({ label }) => label === "push"),
		false,
	);
});

test("bare edit opens the prefilled editor while text and budget edits keep their route", () => {
	for (const features of [{}, QUEUE_FEATURE]) {
		assert.deepEqual(parseCommand("edit", features), { kind: "modify" });
		assert.deepEqual(parseCommand("  edit  ", features), { kind: "modify" });
		assert.deepEqual(parseCommand('edit --tokens 2k "Exact  objective"', features), {
			kind: "edit",
			objective: "Exact  objective",
			tokenBudget: 2_000,
		});
	}
	assert.ok(completeGoalArguments("")?.some(({ value }) => value === "edit"));
	assert.deepEqual(
		completeGoalArguments("ed")?.map(({ value }) => value),
		["edit"],
	);
	assert.equal(completeGoalArguments("unknown-edit"), null);
});

test("modify takes no arguments because the objective is the editor's prefill", () => {
	assert.deepEqual(parseCommand("modify"), { kind: "modify" });
	assert.deepEqual(parseCommand("  modify  "), { kind: "modify" });
	assert.equal(parseCommand("modify something else"), "Usage: /goal modify");

	// `modify` is reserved the way `status` and `pause` are, rather than falling
	// through to an objective the way the non-experimental queue words do: an
	// objective that opens with it is refused with the usage line instead of
	// quietly starting a goal, which is the answer that can be taken back.
	assert.equal(parseCommand("modify the deployment script"), "Usage: /goal modify");
	assert.deepEqual(parseCommand("edit something else"), {
		kind: "edit",
		objective: "something else",
		tokenBudget: undefined,
	});

	assert.deepEqual(
		completeGoalArguments("mod")?.map(({ value }) => value),
		["modify"],
	);
});

test("idle check-in command parses durations and toggles", () => {
	assert.deepEqual(parseCommand("idle-checkin 20m"), {
		kind: "idle-checkin",
		backgroundWaitCheckInMs: 20 * 60 * 1_000,
	});
	assert.deepEqual(parseCommand("idle-check-in 120s"), {
		kind: "idle-checkin",
		backgroundWaitCheckInMs: 120_000,
	});
	assert.deepEqual(parseCommand("idle-checkin off"), {
		kind: "idle-checkin",
		backgroundWaitCheckInMs: null,
	});
	assert.deepEqual(parseCommand("idle-checkin default"), {
		kind: "idle-checkin",
		backgroundWaitCheckInMs: 20 * 60 * 1_000,
	});
	assert.match(String(parseCommand("idle-checkin 30s")), /Invalid idle check-in duration/);

	assert.deepEqual(completeGoalArguments("idle-checkin "), [
		{
			value: "idle-checkin 20m",
			label: "20m",
			description: "Set the background-wait idle check-in interval",
		},
		{
			value: "idle-checkin 10m",
			label: "10m",
			description: "Set the background-wait idle check-in interval",
		},
		{
			value: "idle-checkin 5m",
			label: "5m",
			description: "Set the background-wait idle check-in interval",
		},
		{
			value: "idle-checkin default",
			label: "default",
			description: "Set the background-wait idle check-in interval",
		},
		{
			value: "idle-checkin off",
			label: "off",
			description: "Set the background-wait idle check-in interval",
		},
	]);
});

test("experimental queue commands normalize canonical names and hidden aliases", () => {
	for (const [input, expected] of [
		["add docs", { kind: "add", objective: "docs", tokenBudget: undefined }],
		["push docs", { kind: "add", objective: "docs", tokenBudget: undefined }],
		["prioritize outage", { kind: "prioritize", objective: "outage", tokenBudget: undefined }],
		["unshift outage", { kind: "prioritize", objective: "outage", tokenBudget: undefined }],
		["drop-last", { kind: "drop-last" }],
		["pop", { kind: "drop-last" }],
		["skip", { kind: "skip" }],
		["shift", { kind: "skip" }],
	] as const) {
		assert.deepEqual(parseCommand(input, QUEUE_FEATURE), expected);
	}

	assert.deepEqual(parseCommand("add --tokens 2k docs", QUEUE_FEATURE), {
		kind: "add",
		objective: "docs",
		tokenBudget: 2_000,
	});
	assert.deepEqual(parseCommand("prioritize --tokens 3k outage", QUEUE_FEATURE), {
		kind: "prioritize",
		objective: "outage",
		tokenBudget: 3_000,
	});
});

test("experimental autocomplete exposes intent names but keeps aliases hidden", () => {
	const completions = completeGoalArguments("", QUEUE_FEATURE) ?? [];
	assert.deepEqual(
		completions
			.filter(({ label }) => ["add", "prioritize", "drop-last", "skip"].includes(label))
			.map(({ label }) => label),
		["add", "prioritize", "drop-last", "skip"],
	);
	for (const alias of ["push", "unshift", "pop", "shift"]) {
		assert.equal(
			completions.some(({ label }) => label === alias),
			false,
		);
	}
	assert.deepEqual(completeGoalArguments("add ", QUEUE_FEATURE), [
		{
			value: "add --tokens ",
			label: "--tokens",
			description: "Set a token budget before the queued goal",
		},
	]);
});
