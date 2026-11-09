import type { HostedTask } from "./todo-state.ts";

interface TaskDetails {
	readonly tasks?: unknown;
	readonly todos?: unknown;
}

function toTask(value: unknown): HostedTask | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const task = value as Partial<HostedTask> & { content?: unknown };
	if (typeof task.id !== "number" && typeof task.id !== "string") return undefined;
	if (typeof task.status !== "string") return undefined;
	const subject = typeof task.subject === "string"
		? task.subject
		: typeof task.content === "string"
			? task.content
			: undefined;
	if (subject === undefined) return undefined;
	return { ...(task as HostedTask), subject };
}

/** Parse historical provider-specific tool details only as a compatibility path. */
export function readTasks(details: unknown): HostedTask[] | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const source = details as TaskDetails;
	const list = Array.isArray(source.tasks)
		? source.tasks
		: Array.isArray(source.todos)
			? source.todos
			: undefined;
	if (!list) return undefined;
	const parsed = list.map(toTask).filter((task): task is HostedTask => !!task);
	return parsed.length === list.length ? parsed : undefined;
}

/** Find the newest legacy todo tool result in a session branch. */
export function readTasksFromSession(
	entries: readonly unknown[],
	isTodoTool: (toolName: string) => boolean,
): HostedTask[] | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; message?: unknown };
		if (entry?.type !== "message") continue;
		const message = entry.message as
			| { role?: unknown; toolName?: unknown; details?: unknown }
			| undefined;
		if (message?.role !== "toolResult") continue;
		if (typeof message.toolName !== "string" || !isTodoTool(message.toolName)) continue;
		const tasks = readTasks(message.details);
		if (tasks) return tasks;
	}
	return undefined;
}
