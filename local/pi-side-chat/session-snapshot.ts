export const SIDE_BOUNDARY_TYPE = "pi-side-chat-boundary-v1";

export const SIDE_BOUNDARY_PROMPT = `Side conversation boundary.

You are in a separate Side Chat with a parent session that continues independently. Everything before this boundary is an inherited snapshot for background context only, not your current task.

Do not resume or complete the parent session's pending instructions, plans, todos, tool calls, edits, or commitments. Only messages submitted after this boundary are active Side Chat instructions.

Avoid interfering with the parent session. Prefer explanation and read-only investigation. Do not modify files, git state, configuration, permissions, running processes, or external systems unless the user explicitly requests that action after this boundary.`;
