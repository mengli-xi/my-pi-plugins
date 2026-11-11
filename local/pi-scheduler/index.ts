/**
 * pi-scheduler extension entry.
 *
 * Wires three surfaces (decisions #14/#17):
 * - `schedule_task` tool: the agent-facing main entry. Creates/lists/cancels
 *   tasks by talking to the daemon over the local socket.
 * - `/schedule` command: the human-visible management face (list + cancel +
 *   unread failure summary).
 * - session occupancy: register {sessionId, pid} on session_start, unregister
 *   on shutdown, so the daemon can defer session-target tasks (decision #13).
 *
 * The extension never writes task/run files directly (decision #15); every
 * mutation is an IPC request the daemon applies.
 */

import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { renderCollapsibleRows } from "pi-li-uikit/collapsible-block";
import { bindMailbox, type ProducerEndpoint } from "pi-session-inject/mailbox-v1/light";
import { forgetSchedulerIntent, putSchedulerIntent, type SchedulerDeliveryIntent } from "./src/mailbox-delivery.ts";
import { importSchedulerBranch } from "./src/mailbox-import.ts";
import { INJECTION_TYPE, injectionMail, schedulerProducer } from "./src/mailbox-adapter.ts";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { reconcileDaemonBuild, requestWithAutostart, type EnsureOptions } from "./src/autostart.ts";
import { scheduleArgumentCompletions } from "./src/command-completion.ts";
import { createTask, CreateTaskError } from "./src/create-task.ts";
import { installService } from "./src/install-service.ts";
import { schedulerPaths } from "./src/paths.ts";
import { resolveDaemonRuntime } from "./src/runtime-resolver.ts";
import { resolvePiBinary } from "./src/pi-binary.ts";
import type { Schedule } from "./src/schedule.ts";
import { describeFailure, describeInjectionPrompt, describeTask } from "./src/presentation.ts";
import type { SchedulerRequest, SchedulerResponse } from "./src/protocol.ts";
import type { Task, TaskTarget } from "./src/task.ts";

const here = dirname(fileURLToPath(import.meta.url));
let piBinary: string | undefined;

function ensureOptions(): EnsureOptions {
  const agentDir = getAgentDir();
  const paths = schedulerPaths(agentDir);
  // The daemon requires a source build and a real Node/Bun runtime.
  const runtime = resolveDaemonRuntime();
  if (!runtime) throw new Error("Scheduler daemon 需要 PATH 上的 Node.js 或 Bun runtime");
  return {
    socketPath: paths.socket,
    runtime,
    daemonEntry: daemonEntryPath(),
    agentDir,
    piBinary: piBinary ??= resolvePiBinary(),
  };
}

function daemonEntryPath(): string {
  const bundled = join(here, "dist", "daemon.js");
  if (!existsSync(bundled)) throw new Error("请先在仓库根运行 npm run build -w pi-scheduler");
  return bundled;
}

async function send(body: SchedulerRequest): Promise<SchedulerResponse> {
  return requestWithAutostart(body, ensureOptions());
}

const MIN_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const OCCUPANCY_RETRY_MS = 5_000;
const BINDING_GENERATION_KEY = Symbol.for("pi.scheduler.binding-generation.v1");

interface BindingGenerationCell { next: number; activeBySession: Map<string, number> }

function bindingGenerationCell(): BindingGenerationCell {
  const host = globalThis as unknown as { [BINDING_GENERATION_KEY]?: BindingGenerationCell };
  return host[BINDING_GENERATION_KEY] ?? (host[BINDING_GENERATION_KEY] = { next: 1, activeBySession: new Map() });
}

function nextBindingGeneration(sessionId: string, greaterThan = -1): number {
  const cell = bindingGenerationCell();
  const generation = Math.max(cell.next, greaterThan + 1);
  cell.next = generation + 1;
  cell.activeBySession.set(sessionId, generation);
  return generation;
}

interface LiveInjectionBinding {
  ctx: ExtensionContext;
  sessionId: string;
  holderToken: string;
  bindingGen: number;
  registered: boolean;
  retired: boolean;
  inProgress: boolean;
  holderWarnings: Set<string>;
  poller?: ReturnType<typeof setInterval>;
  occupancyRetry?: ReturnType<typeof setTimeout>;
  unregisterRetries: Map<number, ReturnType<typeof setTimeout>>;
  registerInFlight: Set<number>;
  endpoint: ProducerEndpoint;
  intents: Map<string, SchedulerDeliveryIntent>;
}

function pollIntervalMs(): number {
  const raw = process.env.PI_SCHEDULER_INJECTION_POLL_INTERVAL_MS;
  if (!raw?.trim()) return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(value));
}

function bindingCurrent(bindings: Map<string, LiveInjectionBinding>, binding: LiveInjectionBinding): boolean {
  if (bindings.get(binding.sessionId) !== binding || binding.retired) return false;
  if (bindingGenerationCell().activeBySession.get(binding.sessionId) !== binding.bindingGen) return false;
  try {
    return binding.ctx.sessionManager.getSessionId() === binding.sessionId;
  } catch {
    return false;
  }
}

function contextMatchesBinding(ctx: ExtensionContext, binding: LiveInjectionBinding): boolean {
  return ctx.sessionManager === binding.ctx.sessionManager &&
    ctx.sessionManager.getSessionId() === binding.sessionId;
}

async function unregisterIdentity(binding: LiveInjectionBinding, generation: number): Promise<boolean> {
  try {
    const reply = await send({
      type: "occupancy.unregister",
      sessionId: binding.sessionId,
      pid: process.pid,
      holderToken: binding.holderToken,
      bindingGen: generation,
    });
    if (reply.ok && binding.bindingGen === generation) binding.registered = false;
    return reply.ok;
  } catch {
    return false;
  }
}

function retryUnregisterIdentity(binding: LiveInjectionBinding, generation: number): void {
  if (binding.unregisterRetries.has(generation)) return;
  const timer = setTimeout(() => {
    binding.unregisterRetries.delete(generation);
    void unregisterIdentity(binding, generation).then((released) => {
      if (!released) retryUnregisterIdentity(binding, generation);
    });
  }, OCCUPANCY_RETRY_MS);
  binding.unregisterRetries.set(generation, timer);
  timer.unref?.();
}

async function compensateRegister(binding: LiveInjectionBinding, generation: number): Promise<void> {
  const released = await unregisterIdentity(binding, generation);
  if (!released) retryUnregisterIdentity(binding, generation);
}

async function registerOccupancy(binding: LiveInjectionBinding): Promise<boolean> {
  if (binding.retired) return false;
  // A stale response carries the daemon's persisted generation. Retry the
  // corrected identity in this same call; the 5s timer is only transport/NFR
  // backoff, never a preventable migration delay.
  for (let attempts = 0; attempts < 3 && !binding.retired; attempts++) {
    const generation = binding.bindingGen;
    binding.registerInFlight.add(generation);
    let reply: SchedulerResponse | undefined;
    try {
      reply = await send({
        type: "occupancy.register",
        sessionId: binding.sessionId,
        pid: process.pid,
        holderToken: binding.holderToken,
        bindingGen: generation,
      });
    } catch {
      // The daemon may have applied register before its response was lost. A
      // retired/superseded binding must compensate this exact identity after
      // every in-flight request settles, including transport failure.
      binding.registerInFlight.delete(generation);
      if (binding.retired || binding.bindingGen !== generation) await compensateRegister(binding, generation);
      return false;
    }
    binding.registerInFlight.delete(generation);
    if (!reply.ok) {
      if (!binding.retired && typeof reply.currentGeneration === "number") {
        binding.bindingGen = nextBindingGeneration(binding.sessionId, reply.currentGeneration);
        continue;
      }
      return false;
    }
    if (binding.retired || binding.bindingGen !== generation) {
      await compensateRegister(binding, generation);
      return false;
    }
    binding.registered = true;
    return true;
  }
  return false;
}

function retryOccupancy(
  pi: ExtensionAPI,
  bindings: Map<string, LiveInjectionBinding>,
  binding: LiveInjectionBinding,
): void {
  if (binding.occupancyRetry || !bindingCurrent(bindings, binding)) return;
  binding.occupancyRetry = setTimeout(() => {
    binding.occupancyRetry = undefined;
    if (!bindingCurrent(bindings, binding)) return;
    void registerOccupancy(binding).then((registered) => {
      if (!bindingCurrent(bindings, binding)) return;
      if (registered && binding.ctx.isIdle()) void pumpInjection(pi, bindings, binding);
      else if (!registered) retryOccupancy(pi, bindings, binding);
    });
  }, OCCUPANCY_RETRY_MS);
  binding.occupancyRetry.unref?.();
}

async function unregisterOccupancy(binding: LiveInjectionBinding): Promise<boolean> {
  return unregisterIdentity(binding, binding.bindingGen);
}

function retryUnregister(binding: LiveInjectionBinding): void {
  retryUnregisterIdentity(binding, binding.bindingGen);
}

async function pumpInjection(
  pi: ExtensionAPI,
  bindings: Map<string, LiveInjectionBinding>,
  binding: LiveInjectionBinding,
): Promise<void> {
  if (binding.inProgress || !binding.registered || !bindingCurrent(bindings, binding)) return;
  // Capture the mailbox scope before starting IPC; late replies cannot rehome.
  binding.inProgress = true;
  try {
    const target = binding.endpoint.target(binding.ctx);
    const branch = binding.ctx.sessionManager.getBranch();
    const nativeProofs = branch.flatMap((entry) => {
      if (entry.type !== "custom_message" || entry.customType !== INJECTION_TYPE) return [];
      const id = (entry.details as { injection_id?: unknown } | undefined)?.injection_id;
      return typeof id === "string" ? [{ injectionId: id, anchorEntryId: entry.parentId, entryId: entry.id,
        message: { customType: entry.customType, content: entry.content, display: entry.display, details: entry.details } }] : [];
    });
    const polled = await send({ type: "injection.offers", sessionId: binding.sessionId, pid: process.pid,
      holderToken: binding.holderToken, bindingGen: binding.bindingGen,
      anchorEntryId: binding.ctx.sessionManager.getLeafId(), nativeProofs });
    if (!bindingCurrent(bindings, binding)) return;
    // Only the offers authorization failure invalidates occupancy. Keep the
    // exact legacy string for clients running against a pre-diagnostic daemon.
    if (!polled.ok && (polled.holderRejection || polled.error === "not unique live session holder")) {
      binding.registered = false;
      const reason = polled.holderRejection ?? "holder-rejected (legacy daemon)";
      if (!binding.holderWarnings.has(reason)) {
        binding.holderWarnings.add(reason);
        binding.ctx.ui.notify(`Scheduler mailbox: ${reason}; sessionId=${binding.sessionId} pid=${process.pid} ` +
          `generation=${binding.bindingGen} token=${binding.holderToken.slice(0, 8)} ` +
          `binding=current registered=${binding.registered} retired=${binding.retired} inProgress=${binding.inProgress}; ` +
          "retrying registration in 5s.", "warning");
      }
      retryOccupancy(pi, bindings, binding);
      return;
    }
    if (!polled.ok) throw new Error(polled.error);
    if (polled.type !== "injection-offers") throw new Error("invalid scheduler mailbox offer response");
    binding.holderWarnings.clear();
    for (const item of polled.unknown) binding.ctx.ui.notify(`Scheduler injection ${item.injectionId}: ${item.reason}; unknown.`, "warning");
    const imported = await importSchedulerBranch({ branch, offers: polled.offers, unknownIds: new Set(polled.unknown.map((item) => item.injectionId)), endpoint: binding.endpoint, target, send,
      diagnostic: (message) => { if (bindingCurrent(bindings, binding)) binding.ctx.ui.notify(message, "warning"); } });
    for (const offer of polled.offers) {
      if (imported.has(offer.injectionId)) continue;
      if (!bindingCurrent(bindings, binding)) return;
      const result = await putSchedulerIntent({ endpoint: binding.endpoint, target, mail: injectionMail(offer), intents: binding.intents,
        recovered: offer.recovered !== false, branch, leafId: branch.at(-1)?.id ?? null });
      if (result.kind === "held") { binding.ctx.ui.notify(`Scheduler mailbox: ${result.reason}`, "warning"); continue; }
      // A terminal return is authoritative and never a reason to append/wake.
      if (result.kind === "terminal") {
        const response = await send({ type: "injection.terminal", evidence: result.evidence });
        if (!response.ok || response.type !== "ack") throw new Error(response.ok ? "invalid scheduler terminal ACK" : response.error);
        forgetSchedulerIntent(binding.intents, result.evidence);
      }
    }
  } catch (error) {
    if (bindingCurrent(bindings, binding)) binding.ctx.ui.notify(
      `Scheduler mailbox: ${error instanceof Error ? error.message : String(error)}`, "warning");
  } finally {
    binding.inProgress = false;
  }
}

function registerInjectionRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(INJECTION_TYPE, (message, options, theme: Theme) => {
    const details = message.details && typeof message.details === "object"
      ? message.details as { title?: unknown }
      : undefined;
    const body = typeof message.content === "string" ? message.content : "";
    const { summary, preview } = describeInjectionPrompt(body, details);
    class InjectionBlock implements Component {
      render(width: number): string[] {
        return renderCollapsibleRows({
          summary: `${theme.fg("accent", "⏰")} ${summary}`,
          preview,
          expanded: options.expanded,
        }, width);
      }
      invalidate(): void {}
    }
    const box = new Box(options.outputPad, 0);
    box.addChild(new InjectionBlock());
    return box;
  });
}

// ── tool input schema ───────────────────────────────────────────────────────

const ScheduleSchema = Type.Union([
  Type.Object({ kind: Type.Literal("once"), at: Type.Number({ description: "epoch ms" }) }),
  Type.Object({ kind: Type.Literal("daily"), at: Type.String({ description: "HH:MM 24h" }) }),
  Type.Object({
    kind: Type.Literal("weekly"),
    dayOfWeek: Type.Integer({ minimum: 0, maximum: 6 }),
    at: Type.String({ description: "HH:MM 24h" }),
  }),
  Type.Object({ kind: Type.Literal("interval"), everyMs: Type.Integer({ minimum: 60000 }) }),
]);

const CreateParams = Type.Object({
  action: Type.Literal("create"),
  title: Type.String({ description: "Short human-facing label" }),
  prompt: Type.String({ description: "Self-contained instruction to run at each occurrence" }),
  schedule: ScheduleSchema,
  target: Type.Union([
    Type.Object({
      kind: Type.Literal("agent"),
      cwd: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
    }),
    Type.Object({
      kind: Type.Literal("session"),
      sessionId: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      sessionDir: Type.Optional(Type.String()),
    }),
  ]),
  timeZone: Type.Optional(Type.String({ description: "IANA zone; defaults to host zone" })),
  toleranceMs: Type.Optional(Type.Integer({ minimum: 0, description: "Lateness allowance; default 5m" })),
});

const ManageParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("cancel"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("runNow"),
  ]),
  id: Type.Optional(Type.String()),
});

const SchedulerParams = Type.Union([CreateParams, ManageParams]);

// ── helpers ─────────────────────────────────────────────────────────────────

function anchoredSchedule(schedule: Schedule, now: number): Schedule {
  // interval needs an anchor; the tool schema omits it so the agent cannot set
  // a surprising one. Anchor at creation time (decision #24 kin).
  if (schedule.kind === "interval" && !("anchor" in schedule && (schedule as { anchor?: number }).anchor)) {
    return { ...schedule, anchor: now };
  }
  return schedule;
}

function resolveAgentTarget(raw: Record<string, unknown>, ctx: ExtensionContext): TaskTarget {
  return {
    kind: "agent",
    cwd: (raw.cwd as string) || ctx.cwd || process.cwd(),
    provider: (raw.provider as string) || ctx.model?.provider || "",
    model: (raw.model as string) || ctx.model?.id || "",
    ...(raw.thinking ? { thinking: raw.thinking as string } : {}),
  };
}

/**
 * The live session's storage directory, frozen so the daemon resumes the
 * session from the exact same directory the creator used. Pi's default session
 * dir is a per-cwd encoded subdirectory (not `sessions/` itself), so a naive
 * `=== join(agentDir,"sessions")` check never matches and "portable" omission
 * is impossible anyway. We therefore always freeze the concrete directory the
 * session lives in; `usesDefaultSessionDir()` only tells us whether it happens
 * to be the default, which does not change what the daemon must pass.
 */
function sessionDirFromCtx(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionDir?.() || undefined;
}

// ── extension ────────────────────────────────────────────────────────────────

export default function schedulerExtension(pi: ExtensionAPI): void {
  const mailbox = bindMailbox(pi);
  const bindings = new Map<string, LiveInjectionBinding>();
  let endpoint: ProducerEndpoint;
  endpoint = mailbox.registerProducer(schedulerProducer(send, (key, reason, fence) => endpoint.cancel(key, reason, fence), (sessionId) => {
    const binding = bindings.get(sessionId);
    return binding && bindingCurrent(bindings, binding) ? binding.ctx.sessionManager.getBranch() : undefined;
  }, (evidence) => {
    const binding = bindings.get(evidence.scope.sessionId);
    if (binding) forgetSchedulerIntent(binding.intents, evidence);
  }));
  pi.registerTool({
    name: "schedule_task",
    label: "Schedule",
    description:
      "Create or manage a scheduled task that runs a frozen prompt later, even after Pi exits. " +
      "Use action=create with a structured schedule (once/daily/weekly/interval) and a target " +
      "(agent = a fresh isolated session; session = delivered into a specific Pi session). " +
      "If the user has not made the target explicit, ask them before creating. " +
      "Other actions: list, cancel, pause, resume, runNow.",
    parameters: SchedulerParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const input = params as Record<string, unknown>;
      try {
        if (input.action === "create") {
          const now = Date.now();
          const rawTarget = input.target as Record<string, unknown>;
          const target: TaskTarget = rawTarget.kind === "session"
            ? {
                kind: "session",
                sessionId: (rawTarget.sessionId as string) || ctx.sessionManager.getSessionId(),
                // Freeze the session's project cwd (and session dir when custom)
                // so the daemon resumes it in the same namespace instead of
                // hitting Pi's cross-project fork prompt (decision #10).
                cwd: (rawTarget.cwd as string) || ctx.sessionManager.getCwd?.() || ctx.cwd || process.cwd(),
                ...(((rawTarget.sessionDir as string) || sessionDirFromCtx(ctx))
                  ? { sessionDir: (rawTarget.sessionDir as string) || sessionDirFromCtx(ctx) }
                  : {}),
              }
            : resolveAgentTarget(rawTarget, ctx);
          const task = createTask({
            title: input.title as string,
            prompt: input.prompt as string,
            schedule: anchoredSchedule(input.schedule as Schedule, now),
            timeZone: input.timeZone as string | undefined,
            toleranceMs: input.toleranceMs as number | undefined,
            target,
            origin: "agent",
            createdInSession: ctx.sessionManager.getSessionId(),
            now,
          });
          const reply = await send({ type: "task.create", task });
          if (!reply.ok) return textResult(`Failed to schedule: ${reply.error}`, true);
          return textResult(`Scheduled: ${describeTask(task)}`);
        }

        const action = input.action as string;
        if (action === "list") {
          const reply = await send({ type: "task.list" });
          if (!reply.ok || reply.type !== "tasks") return textResult(`Failed to list: ${reply.ok ? "bad reply" : reply.error}`, true);
          if (reply.tasks.length === 0) return textResult("No scheduled tasks.");
          return textResult(reply.tasks.map(describeTask).join("\n"));
        }

        const id = input.id as string | undefined;
        if (!id) return textResult(`action ${action} requires an id`, true);
        const request: SchedulerRequest =
          action === "cancel" ? { type: "task.delete", id } :
          action === "pause" ? { type: "task.pause", id } :
          action === "resume" ? { type: "task.resume", id } :
          { type: "task.runNow", id };
        const reply = await send(request);
        if (!reply.ok) return textResult(`Failed: ${reply.error}`, true);
        return textResult(`Done: ${action} ${id}`);
      } catch (error) {
        if (error instanceof CreateTaskError) return textResult(`Invalid task: ${error.message}`, true);
        return textResult(`Scheduler error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  pi.registerCommand("schedule", {
    description: "List scheduled tasks, cancel one, or review scheduled-task failures",
    getArgumentCompletions: scheduleArgumentCompletions,
    handler: async (args: string, ctx: ExtensionContext) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);
      const sub = argv[0] ?? "list";
      try {
        if (sub === "install") {
          const options = ensureOptions();
          const result = installService({
            runtime: options.runtime,
            daemonEntry: options.daemonEntry,
            agentDir: getAgentDir(),
            piBinary: options.piBinary,
            logPath: schedulerPaths(getAgentDir()).log,
          });
          ctx.ui.notify(
            result.loaded ? "Scheduler service installed and running." : `Install issue: ${result.detail}`,
            result.loaded ? "info" : "warning",
          );
          return;
        }
        if (sub === "failures") {
          const reply = await send({ type: "failures.list" });
          if (reply.ok && reply.type === "failures") {
            if (reply.failures.length === 0) { ctx.ui.notify("No scheduled-task failures.", "info"); return; }
            await presentText(ctx, reply.failures.map(describeFailure).join("\n"));
            await send({ type: "failures.acknowledge", through: Date.now() });
          }
          return;
        }
        if (sub === "cancel") {
          const id = argv[1];
          if (!id) { ctx.ui.notify("Usage: /schedule cancel <id>", "warning"); return; }
          const reply = await send({ type: "task.delete", id });
          ctx.ui.notify(reply.ok ? `Cancelled ${id}` : `Failed: ${(reply as { error: string }).error}`, reply.ok ? "info" : "warning");
          return;
        }
        // default: list
        const reply = await send({ type: "task.list" });
        if (reply.ok && reply.type === "tasks") {
          await presentText(ctx, reply.tasks.length ? reply.tasks.map(describeTask).join("\n") : "No scheduled tasks.");
        } else {
          ctx.ui.notify("Could not reach the scheduler daemon.", "warning");
        }
      } catch (error) {
        ctx.ui.notify(`Scheduler error: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  registerInjectionRenderer(pi);

  // One binding owns one session identity. The daemon only offers injection to
  // a unique tokenful holder; retiring first prevents a late poll/ack from an
  // old session replacement from affecting the new binding with the same pid.
  const retire = (binding: LiveInjectionBinding) => {
    binding.retired = true;
    binding.intents.clear();
    if (binding.poller) clearInterval(binding.poller);
    if (binding.occupancyRetry) clearTimeout(binding.occupancyRetry);
    // Keep generation-specific unregister retries: an already-sent register
    // may still land after retirement and must be compensated. Stop only the
    // retry that would create a new registration for this retired binding.
    if (bindings.get(binding.sessionId) === binding) bindings.delete(binding.sessionId);
    const generations = bindingGenerationCell().activeBySession;
    if (generations.get(binding.sessionId) === binding.bindingGen) generations.delete(binding.sessionId);
    void unregisterOccupancy(binding).then((released) => {
      if (!released) retryUnregister(binding);
    });
  };
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const prior = bindings.get(sessionId);
    if (prior) retire(prior);
    const binding: LiveInjectionBinding = {
      ctx,
      sessionId,
      holderToken: randomUUID(),
      bindingGen: nextBindingGeneration(sessionId),
      registered: false,
      retired: false,
      inProgress: false,
      holderWarnings: new Set(),
      unregisterRetries: new Map(),
      registerInFlight: new Set(),
      endpoint,
      intents: new Map(),
    };
    bindings.set(sessionId, binding);
    binding.poller = setInterval(() => {
      if (bindingCurrent(bindings, binding) && binding.registered && ctx.isIdle()) {
        void pumpInjection(pi, bindings, binding);
      }
      if (bindingCurrent(bindings, binding) && !binding.registered) retryOccupancy(pi, bindings, binding);
    }, pollIntervalMs());
    binding.poller.unref?.();
    const registered = await registerOccupancy(binding);
    if (!registered) retryOccupancy(pi, bindings, binding);
    await surfaceUnreadFailures(ctx);
    if (registered && ctx.isIdle()) await pumpInjection(pi, bindings, binding);
    // Reconcile in the background: a draining daemon may need to wait for a
    // real subprocess, so session_start must never hold Pi's first frame. Once
    // the rebuilt daemon owns the socket, register this live holder again—the
    // previous daemon's occupancy format may have been legacy-only.
    void reconcileDaemonBuild(ensureOptions()).then(() => {
      if (!bindingCurrent(bindings, binding)) return;
      binding.registered = false;
      void registerOccupancy(binding).then((current) => {
        if (!current) retryOccupancy(pi, bindings, binding);
        else if (binding.ctx.isIdle()) void pumpInjection(pi, bindings, binding);
      });
    }).catch(() => { /* build reconciliation is best-effort at startup */ });
  });
  pi.on("agent_settled", (_event, ctx) => {
    // Pi creates a fresh ExtensionContext per event, so context object identity
    // is not lifecycle identity. The session id locates this instance's active
    // binding; its token/generation protects the daemon against older instances.
    const binding = bindings.get(ctx.sessionManager.getSessionId());
    if (!binding || !contextMatchesBinding(ctx, binding) || !bindingCurrent(bindings, binding)) return;
    if (binding.registered && ctx.isIdle()) void pumpInjection(pi, bindings, binding);
    if (!binding.registered) retryOccupancy(pi, bindings, binding);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const binding = bindings.get(ctx.sessionManager.getSessionId());
    if (!binding || !contextMatchesBinding(ctx, binding)) return;
    retire(binding);
  });
}

async function surfaceUnreadFailures(ctx: ExtensionContext): Promise<void> {
  try {
    const reply = await send({ type: "failures.list" });
    if (reply.ok && reply.type === "failures" && reply.failures.length > 0) {
      ctx.ui.notify(
        `${reply.failures.length} scheduled-task failure(s). Run /schedule failures.`,
        "warning",
      );
    }
  } catch {
    // best effort
  }
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: isError ? { error: text } : undefined,
  };
}

async function presentText(ctx: ExtensionContext, text: string): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify(text, "info");
}
