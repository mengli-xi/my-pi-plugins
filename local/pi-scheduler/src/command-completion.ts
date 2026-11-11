const SCHEDULE_COMMANDS = ["list", "install", "failures", "cancel "] as const;

export function scheduleArgumentCompletions(prefix: string): Array<{
  value: string;
  label: string;
  description: string;
}> | null {
  const query = prefix.trimStart().toLowerCase();
  const descriptions: Record<(typeof SCHEDULE_COMMANDS)[number], string> = {
    list: "List scheduled tasks",
    install: "Install or refresh the scheduler service",
    failures: "Review and acknowledge task failures",
    "cancel ": "Cancel a task by ID",
  };
  const matches = SCHEDULE_COMMANDS
    .filter((value) => (value.endsWith(" ") ? query !== value : query !== value.trim()) && value.startsWith(query))
    .map((value) => ({ value, label: value.trim(), description: descriptions[value] }));
  return matches.length > 0 ? matches : null;
}
