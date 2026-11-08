---
name: subagents
description: Create and coordinate persistent background agents for independent investigation, implementation, or review.
---

# Subagents

Use collaboration tools for concrete independent work. All agents share the workspace; assign distinct file ownership and preserve concurrent edits.

## Create work

`spawn_agent` creates an open persistent agent and admits its first Task. Omit `model` to inherit the current model. Query `list_subagent_models` only when the user names a model or the work needs another one. Choose `explorer` for read-only inspection and `worker` for implementation and commands; delegation never adds tools the parent lacks.

`fork_turns` defaults to `none`. `all` inherits the effective context, and a positive integer takes that many complete turns. On `effective-context-unavailable`, use `none`; do not rebuild discarded context from raw history.

The default Task timeout is 30 minutes. `task_timeout_ms` accepts 60,000–86,400,000 milliseconds and overrides the role/config timeout. Each new Task starts its deadline on its first execution grant; steering and waiting activation never extend it.

Names remain reserved after completion or close. Continue the existing target instead of spawning the same name. The default limits are 32 open agents per Main and 10 active Tasks per Main/process. Closed agents do not consume open slots. Waiting agents release active slots. Excess active work queues in admission order.

## Continue, resume, and close

Use `send_input({target, message})` to continue an open agent:

- Idle input starts a new Task.
- Running input steers the current Task. It keeps the Task ID, owner, lease, and deadline.
- Starting/queued input binds to the selected Task, without adding another Task.
- Waiting input immediately requests a slot for the same Task; when capacity is full it waits for that slot.
- `interrupt: true` stops the selected Task and starts a new Task with your message. Other queued Tasks remain after the replacement.

To assign independent work to a busy agent, wait for its Completion and then send input. Ordinary busy input is steering. The user can enqueue independent subsequent work through the UI's after-current intent.

Only Main has `resume_agent` and `close_agent`. A closed target rejects input, including interrupting input. Use:

```text
resume_agent({target: "/root/reviewer"})
send_input({target: "/root/reviewer", message: "Review the new patch."})
```

Resume opens only the target, idle, using its frozen profile and history. It starts no Task, lease, provider call, or automatic compaction. Already open targets return idempotently. It never resumes ancestors or descendants automatically.

Close an idle subtree after collecting its results when no immediate work remains. `close_agent({target})` requires every agent in its structural subtree to be idle. `force: true` cancels all current and queued work in that subtree, then closes it. Every cancelled Task gets one interrupted Completion. History and unread results remain. Closing may report pending cleanup while cancellation drains; do not resume until it is closed. Do not retain idle agents as a pool or cancel useful work just to release capacity.

Returning to Main does not close an agent. Quit, new session, session switch, and reload force-close the previous Main's complete tree. Returning to that Main leaves its agents closed until explicitly resumed.

## Wait and report

Results arrive automatically. Do not poll `list_agents`. Use `wait_agents` only when the next step depends on Tasks you own. It snapshots admitted Task IDs; later Tasks do not extend the barrier. Call it as the only tool in its assistant message and stop that turn after an armed result.

Main can assign a new Task to any descendant; that Task's Completion returns to Main. User new Tasks also return to Main. Child-origin Tasks return to that child. Steering never changes the current Task's owner. Child `send_input` is limited to its open direct descendants; child completion reporting uses normal final replies or `finish_task`.

The default delegation depth is 1; those children have no spawn tool. With `execution.maxDepth=2`, children may spawn grandchildren, which have no spawn tool. Frozen permissions can tighten on resume and never expand.

A normal final reply records completed. Use `finish_task` with partial for usable unfinished work, or blocked with a reason (`user-input-required`, `approval-required`, `external-prerequisite`) when another action is required. Background agents cannot open interactive dialogs or approval flows.

`list_agents` includes closed records, lifecycle, current/queued work, latest outcome, and resume diagnostics. Tool errors contain a code and the next action. Configuration errors reject new work while Main, close, read-only lists, and accepted delivery remain available.
