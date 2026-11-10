const MAX_OBJECTIVE_LENGTH = 4_000;

export interface GoalCommandFeatures {
	experimentalGoals?: boolean;
}

export interface CommandResult {
	kind:
		| "start"
		| "pause"
		| "resume"
		| "clear"
		| "show"
		| "edit"
		| "modify"
		| "add"
		| "prioritize"
		| "drop-last"
		| "skip"
		| "idle-checkin";
	objective?: string;
	tokenBudget?: number;
	backgroundWaitCheckInMs?: number | null;
}

export interface GoalArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const TOKEN_BUDGET_COMPLETION: GoalArgumentCompletion = {
	value: "--tokens ",
	label: "--tokens",
	description: "Set a token budget before the goal",
};
const GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "pause", label: "pause", description: "Pause the active goal" },
	{ value: "resume", label: "resume", description: "Resume a stopped or budget-limited goal" },
	{ value: "clear", label: "clear", description: "Clear the current goal" },
	{ value: "edit", label: "edit", description: "Edit the current goal objective" },
	{
		value: "modify",
		label: "modify",
		description: "Edit the current goal objective in an editor",
	},
	{ value: "status", label: "status", description: "Show the current goal" },
	{
		value: "idle-checkin ",
		label: "idle-checkin",
		description: "Set how often /goal checks long-running background work",
	},
	TOKEN_BUDGET_COMPLETION,
];
const QUEUE_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "add", label: "add", description: "Add a goal to the end of the queue" },
	{
		value: "prioritize",
		label: "prioritize",
		description: "Prioritize a new goal at the front of the queue",
	},
	{ value: "drop-last", label: "drop-last", description: "Remove the last goal" },
	{ value: "skip", label: "skip", description: "Skip the current goal" },
];

export function completeGoalArguments(
	argumentPrefix: string,
	features: GoalCommandFeatures = {},
): GoalArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	const completions = features.experimentalGoals
		? [
				...GOAL_ARGUMENT_COMPLETIONS.slice(0, -1),
				...QUEUE_ARGUMENT_COMPLETIONS,
				TOKEN_BUDGET_COMPLETION,
			]
		: [...GOAL_ARGUMENT_COMPLETIONS];
	if (prefix === "") return completions;

	const objectiveOption = features.experimentalGoals
		? /^(edit|add|prioritize)\s+(\S*)$/.exec(prefix)
		: /^edit\s+(\S*)$/.exec(prefix);
	if (objectiveOption) {
		const command = features.experimentalGoals ? (objectiveOption[1] ?? "edit") : "edit";
		const optionPrefix = features.experimentalGoals
			? (objectiveOption[2] ?? "")
			: (objectiveOption[1] ?? "");
		return optionPrefix === "" || "--tokens".startsWith(optionPrefix)
			? [
					{
						value: `${command} --tokens `,
						label: "--tokens",
						description:
							command === "edit"
								? "Set a token budget before the updated goal"
								: "Set a token budget before the queued goal",
					},
				]
			: null;
	}
	const idleCheckInOption = /^idle-check-?in\s+(\S*)$/.exec(prefix);
	if (idleCheckInOption) {
		const valuePrefix = idleCheckInOption[1] ?? "";
		return ["20m", "10m", "5m", "default", "off"]
			.filter((value) => value.startsWith(valuePrefix))
			.map((value) => ({
				value: `idle-checkin ${value}`,
				label: value,
				description: "Set the background-wait idle check-in interval",
			}));
	}
	if (/\s/.test(prefix)) return null;
	const matches = completions.filter(
		(item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
	);
	return matches.length > 0 ? matches : null;
}

export function parseCommand(
	args: string,
	features: GoalCommandFeatures = {},
): CommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };
	const [first, ...rest] = tokens;
	if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "Usage: /goal pause";
	if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "Usage: /goal resume";
	if (first === "clear" || first === "stop")
		return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
	if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
	if (first === "idle-checkin" || first === "idle-check-in") return parseIdleCheckIn(rest);
	if (first === "edit")
		return rest.length === 0 ? { kind: "modify" } : parseObjective("edit", rest);
	// The objective is the editor's prefill rather than an argument, so anything
	// after the word would be silently dropped.
	if (first === "modify") return rest.length === 0 ? { kind: "modify" } : "Usage: /goal modify";

	if (features.experimentalGoals) {
		if (first === "drop-last" || first === "pop") {
			return rest.length === 0 ? { kind: "drop-last" } : "Usage: /goal drop-last";
		}
		if (first === "skip" || first === "shift") {
			return rest.length === 0 ? { kind: "skip" } : "Usage: /goal skip";
		}
		if (first === "add" || first === "push") return parseObjective("add", rest);
		if (first === "prioritize" || first === "unshift") {
			return parseObjective("prioritize", rest);
		}
	}

	return parseObjective("start", tokens);
}

function parseIdleCheckIn(tokens: string[]): CommandResult | string {
	if (tokens.length !== 1) return "Usage: /goal idle-checkin <duration|default|off>";
	const [value] = tokens;
	if (value === "off" || value === "disable" || value === "disabled") {
		return { kind: "idle-checkin", backgroundWaitCheckInMs: null };
	}
	if (value === "default") {
		return { kind: "idle-checkin", backgroundWaitCheckInMs: 20 * 60 * 1_000 };
	}
	const duration = parseDurationMs(value);
	if (duration === undefined || duration < 60_000) {
		return `Invalid idle check-in duration: ${value}. Use at least 1m, or off/default.`;
	}
	return { kind: "idle-checkin", backgroundWaitCheckInMs: duration };
}

function parseObjective(
	kind: "start" | "edit" | "add" | "prioritize",
	tokens: string[],
): CommandResult | string {
	let tokenBudget: number | undefined;
	const objectiveTokens = [...tokens];
	if (objectiveTokens[0] === "--tokens") {
		const rawBudget = objectiveTokens[1];
		if (!rawBudget) {
			return kind === "start"
				? "Usage: /goal --tokens 100k <goal_to_complete>"
				: `Usage: /goal ${kind} --tokens 100k <goal_to_complete>`;
		}
		const parsedBudget = parseTokenBudget(rawBudget);
		if (parsedBudget === undefined) return `Invalid token budget: ${rawBudget}`;
		tokenBudget = parsedBudget;
		objectiveTokens.splice(0, 2);
	}
	if (objectiveTokens.length === 0) {
		if (kind === "start") return "Usage: /goal <goal_to_complete>";
		return `Usage: /goal ${kind} <goal_to_complete>`;
	}
	return { kind, objective: objectiveTokens.join(" "), tokenBudget };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parseTokenBudget(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier =
		match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return normalizeTokenBudget(Math.floor(amount * multiplier));
}

function parseDurationMs(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|min|mins|minute|minutes|h|hr|hour|hours)?$/iu.exec(
		value.trim(),
	);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const unit = match[2]?.toLowerCase() ?? "m";
	const multiplier =
		unit === "ms"
			? 1
			: unit === "s"
				? 1_000
				: unit === "h" || unit === "hr" || unit === "hour" || unit === "hours"
					? 3_600_000
					: 60_000;
	const duration = Math.floor(amount * multiplier);
	return Number.isSafeInteger(duration) && duration > 0 ? duration : undefined;
}

export function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "Usage: /goal <goal_to_complete>";
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
	}
	return undefined;
}

function normalizeTokenBudget(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
