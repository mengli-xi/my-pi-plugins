export const TASK_TIMEOUT_DEFAULT_MS = 1_800_000;
export const TASK_TIMEOUT_MIN_MS = 60_000;
export const TASK_TIMEOUT_MAX_MS = 86_400_000;
export const TASK_TIMEOUT_DESCRIPTION = `Wall-clock limit per task, ${TASK_TIMEOUT_MIN_MS}..${TASK_TIMEOUT_MAX_MS} ms. Frozen for this agent and its follow-up tasks. Priority: explicit value, role, execution.taskTimeoutMs, ${TASK_TIMEOUT_DEFAULT_MS}. Starts at the first execution grant; waiting does not extend it.`;

export function validateTaskTimeoutMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < TASK_TIMEOUT_MIN_MS || (value as number) > TASK_TIMEOUT_MAX_MS)
    throw new Error(`invalid-arguments: task_timeout_ms must be an integer ${TASK_TIMEOUT_MIN_MS}..${TASK_TIMEOUT_MAX_MS}`);
  return value as number;
}
export function resolveTaskTimeoutMs(explicit?: number, role?: number, configured?: number): number {
  return validateTaskTimeoutMs(explicit ?? role ?? configured ?? TASK_TIMEOUT_DEFAULT_MS);
}
/** Depth is structural, even if a cached depth or a fresh runtime claims otherwise. */
export function persistentAgentDepth(agents: readonly { agent_id: string; parent_agent_id?: string }[], agentId: string): 1 | 2 {
  const seen = new Set<string>();
  let id: string | undefined = agentId;
  let depth = 0;
  while (id) {
    if (seen.has(id)) throw new Error("depth-limit: cyclic persistent parent chain");
    seen.add(id);
    const agent = agents.find(item => item.agent_id === id);
    if (!agent) throw new Error("depth-limit: missing persistent parent");
    depth++;
    if (depth > 2) throw new Error("depth-limit: maximum depth is 2");
    id = agent.parent_agent_id;
  }
  return depth as 1 | 2;
}
/** Durable Task interrupt intent plus the durable deadline identifies timeout. */
export function taskTimedOut(task: { deadline_at_ms?: number; interrupt_requested_at?: string }): boolean {
  return task.deadline_at_ms !== undefined && task.interrupt_requested_at !== undefined
    && Date.parse(task.interrupt_requested_at) >= task.deadline_at_ms;
}
