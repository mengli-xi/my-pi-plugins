/**
 * Daemon-side socket server. Listens on the Unix socket, applies every request
 * against the store/occupancy (the daemon is the single writer), and answers.
 * Task mutations trigger an immediate re-plan via the injected `onMutate` so a
 * newly created task is scheduled without waiting for the next timer.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import {
  encodeFrame,
  FrameDecoder,
  type Envelope,
  type MailboxInjectionRequest,
  type InjectionAckCallback,
  type InjectionNackCallback,
  type InjectionPollCallback,
  type SchedulerRequest,
  type SchedulerResponse,
} from "./protocol.ts";
import type { OccupancyRegistry } from "./occupancy.ts";
import type { SchedulerStore } from "./store.ts";
import type { Task } from "./task.ts";
import { validateTask } from "./create-task.ts";

export interface ControlServerOptions {
  socketPath: string;
  store: SchedulerStore;
  occupancy: OccupancyRegistry;
  /** Called after any change that should trigger a re-plan (create/update/…). */
  onMutate: () => void;
  /** Called for task.runNow: force the given task's next occurrence now. */
  onRunNow: (id: string) => { started: boolean; reason?: string };
  /** Reports the build currently serving this socket and whether it is draining. */
  onDaemonStatus: () => { buildId: string; draining: boolean };
  /** Starts an idempotent drain of this daemon. */
  onDaemonUpdate: () => void;
  /** Daemon-owned injection state transitions. Optional during rolling upgrade. */
  onInjectionPoll?: InjectionPollCallback;
  onInjectionAck?: InjectionAckCallback;
  onInjectionNack?: InjectionNackCallback;
  onMailboxInjection?: (request: MailboxInjectionRequest) => SchedulerResponse;
  now: () => number;
}

export function startControlServer(options: ControlServerOptions): Server {
  // A stale socket from a crashed daemon would block bind; clear it first.
  try {
    rmSync(options.socketPath, { force: true });
  } catch {
    // best effort
  }
  const server = createServer((socket) => handleConnection(socket, options));
  // A Unix socket inherits the process umask (commonly 0755). Bind is synchronous,
  // so tighten it immediately: a shared /tmp or multi-user agent dir must not let
  // another local user drive this profile's daemon.
  const restrict = () => {
    try { chmodSync(options.socketPath, 0o600); } catch { /* best effort */ }
  };
  server.listen(options.socketPath, restrict);
  restrict();
  return server;
}

function handleConnection(socket: Socket, options: ControlServerOptions): void {
  const decoder = new FrameDecoder<SchedulerRequest>();
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let envelopes: Array<Envelope<SchedulerRequest>>;
    try {
      envelopes = decoder.push(chunk);
    } catch (error) {
      // Protocol violation: answer once and drop the connection.
      socket.write(encodeFrame<Envelope<SchedulerResponse>["body"]>({
        id: -1,
        body: { ok: false, error: error instanceof Error ? error.message : String(error) },
      } as Envelope<SchedulerResponse>));
      socket.destroy();
      return;
    }
    for (const envelope of envelopes) {
      const body = apply(envelope.body, options);
      socket.write(encodeFrame<SchedulerResponse>({ id: envelope.id, body }));
    }
  });
  socket.on("error", () => socket.destroy());
}

function rejectActiveInjection(
  taskId: string,
  store: SchedulerStore,
): { ok: false; error: string } | undefined {
  if (store.listInjectionsForTask(taskId).length === 0) return undefined;
  return { ok: false, error: "task has active injection occurrence" };
}

function apply(request: SchedulerRequest, options: ControlServerOptions): SchedulerResponse {
  const { store, occupancy } = options;
  try {
    switch (request.type) {
      case "injection.offers":
      case "injection.current":
      case "injection.handoff":
      case "injection.start":
      case "injection.failed":
      case "injection.terminal": {
        if (!options.onMailboxInjection) return { ok: false, error: "mailbox injection unavailable" };
        const response = options.onMailboxInjection(request);
        if (response.ok && request.type !== "injection.current") options.onMutate();
        return response;
      }
      case "ping":
        return { ok: true, type: "pong" };
      case "daemon.status": {
        const status = options.onDaemonStatus();
        return { ok: true, type: "daemon-status", ...status };
      }
      case "daemon.update":
        options.onDaemonUpdate();
        return { ok: true, type: "ack" };
      case "task.create":
        // Create is not an upsert: accepting an existing id would let a caller
        // overwrite a task snapshot while its injection marker owns an older
        // occurrence. Updates have an explicit guarded path below.
        if (store.getTask(request.task.id)) return { ok: false, error: `task already exists: ${request.task.id}` };
        // Validate before persisting: task.create must reject a malformed or
        // incomplete task (e.g. a session target missing cwd) instead of
        // letting the daemon later spawn it with a wrong cwd and silently
        // no-op. task.update already validates; task.create must too.
        validateTask(request.task, options.now());
        store.putTask(request.task);
        options.onMutate();
        return { ok: true, type: "task", task: request.task };
      case "task.update": {
        const existing = store.getTask(request.id);
        if (!existing) return { ok: false, error: `no such task: ${request.id}` };
        const blocked = rejectActiveInjection(request.id, store);
        if (blocked) return blocked;
        const updated: Task = { ...existing, ...request.patch, id: existing.id };
        // Reject a patch that would corrupt the task; the daemon must never
        // persist a schedule/zone/tolerance it cannot later evaluate.
        validateTask(updated, options.now());
        store.putTask(updated);
        options.onMutate();
        return { ok: true, type: "task", task: updated };
      }
      case "task.delete": {
        const blocked = rejectActiveInjection(request.id, store);
        if (blocked) return blocked;
        store.deleteTask(request.id);
        options.onMutate();
        return { ok: true, type: "ack" };
      }
      case "task.pause": {
        const task = store.getTask(request.id);
        if (!task) return { ok: false, error: `no such task: ${request.id}` };
        const blocked = rejectActiveInjection(request.id, store);
        if (blocked) return blocked;
        store.putTask({ ...task, status: "paused" });
        options.onMutate();
        return { ok: true, type: "task", task: { ...task, status: "paused" } };
      }
      case "task.resume": {
        const task = store.getTask(request.id);
        if (!task) return { ok: false, error: `no such task: ${request.id}` };
        const blocked = rejectActiveInjection(request.id, store);
        if (blocked) return blocked;
        store.putTask({ ...task, status: "active" });
        options.onMutate();
        return { ok: true, type: "task", task: { ...task, status: "active" } };
      }
      case "task.runNow": {
        if (!store.getTask(request.id)) return { ok: false, error: `no such task: ${request.id}` };
        const blocked = rejectActiveInjection(request.id, store);
        if (blocked) return blocked;
        const outcome = options.onRunNow(request.id);
        // Surface a refusal (e.g. session held by a live Pi) instead of a bare
        // ack, so the caller learns the run did not start and why.
        if (!outcome.started) return { ok: false, error: outcome.reason ?? "run did not start" };
        return { ok: true, type: "ack" };
      }
      case "task.list":
        return { ok: true, type: "tasks", tasks: store.listTasks() };
      case "task.runs":
        return { ok: true, type: "runs", runs: store.listRuns(request.id) };
      case "failures.list":
        return { ok: true, type: "failures", failures: store.unacknowledgedFailures() };
      case "failures.acknowledge":
        store.acknowledgeFailures(request.through);
        options.onMutate();
        return { ok: true, type: "ack" };
      case "occupancy.register": {
        const registered = occupancy.register(request.sessionId, request.pid, request.holderToken, request.bindingGen);
        if (!registered.accepted) {
          return { ok: false, error: "stale session binding", currentGeneration: registered.currentGeneration };
        }
        options.onMutate();
        return { ok: true, type: "ack" };
      }
      case "occupancy.unregister":
        occupancy.unregister(request.sessionId, request.pid, request.holderToken, request.bindingGen);
        options.onMutate();
        return { ok: true, type: "ack" };
      case "injection.poll": {
        const checked = occupancy.checkHolder(request);
        if (!checked.ok) return { ok: false, error: "not unique live session holder", holderRejection: checked.reason };
        if (!options.onInjectionPoll) return { ok: false, error: "injection unavailable" };
        const injection = options.onInjectionPoll(request);
        options.onMutate();
        return injection === undefined
          ? { ok: true, type: "injection" }
          : { ok: true, type: "injection", injection };
      }
      case "injection.ack": {
        if (!options.onInjectionAck) return { ok: false, error: "injection unavailable" };
        const result = options.onInjectionAck(request);
        if (!result.ok) return result;
        options.onMutate();
        return { ok: true, type: "ack" };
      }
      case "injection.nack": {
        if (!options.onInjectionNack) return { ok: false, error: "injection unavailable" };
        const result = options.onInjectionNack(request);
        if (!result.ok) return result;
        options.onMutate();
        return { ok: true, type: "ack" };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
