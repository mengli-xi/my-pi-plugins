import { DeliveryPending } from "../mailbox/transport.js";
import type { CurrentDecision, Mail, MailboxRunEnd, RecordedNotice, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import { assertMailboxInputAuthority } from "../persistence/mailbox-authority.js";
import { needsChildControl } from "../host/control-residency.js";
import { hasTaskMailbox } from "../host/mailbox-resume.js";
import { TaskDeadlines } from "../host/task-deadlines.js";
import { randomUUID, createHash } from "node:crypto";
import { canonicalJsonV1 } from "../persistence/canonical.js";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentId, TaskId } from "../domain/types.js";
import { persistentAgentDepth } from "../domain/task-policy.js";
import type { HostCallerV1, HostResultV1 } from "../host/types.js";
import type { AgentHostCoreV1 } from "../host/core.js";
import { ProcessAdmissionOwner } from "../host/process-admission.js";
import { readNativeSessionUsageV1, readNativeTerminalProofV1 } from "../persistence/native-terminal.js";
import { ChildEventProcessorV1 } from "../child/events.js";
import type { ChildCapabilityRegistrySnapshotV1 } from "../capabilities/registry.js";
import { ChildSession } from "./child-session.js";
import { latestTaskProgress } from "../host/compact-reinject.js";
import type { ChildToolPort, ChildToolReply } from "../child/tool-port.js";
import type { ChildHostPort } from "./child-tools.js";
import type { TerminalOwner } from "pi-session-runtime/terminal-owner";
import type { ManagedViewCloseReason } from "pi-session-runtime/managed-interactive";

export interface RuntimeStartGrantV1 {
  readonly grantId: string;
  readonly coordinatorGeneration: number;
  readonly agentId: AgentId;
  readonly taskId: TaskId;
  readonly runtimeGeneration: number;
  readonly residency?: "existing" | "granted";
}

export interface RuntimeControllerSchedulerPortV1 {
  registerIdleRuntime?(input: { readonly agentId: AgentId; readonly runtimeGeneration: number }): void;
  requestActive(input: { readonly agentId: AgentId; readonly taskId: TaskId; readonly admissionOrder: number }): void;
  confirmRuntime(input: { readonly grantId: string; readonly runtimeGeneration: number }): void;
  retireResident?(input: { readonly agentId: AgentId; readonly runtimeGeneration: number }): void;
  transitionResident?(input: { readonly agentId: AgentId; readonly runtimeGeneration: number; readonly state: "idle" | "control-pinned" | "waiting-pinned"; readonly pinnedTaskId?: TaskId }): void;
  releaseGrant(input: { readonly grantId: string; readonly coordinatorGeneration: number; readonly runtimeGeneration: number; readonly nextResidency: "idle" | "waiting-pinned" | "control-pinned" | "release-residency" }): void;
}

interface Resident {
  readonly agentId: AgentId; readonly runtimeGeneration: number;
  grant?: RuntimeStartGrantV1;
  /** The activation owned by this grant, never a later mailbox admission. */
  activationOrder?: number;
  phase: "starting" | "running" | "waiting" | "settling" | "idle" | "failed";
  child?: ChildSession;
  assembly?: Promise<ChildSession>;
  startGrant?: RuntimeStartGrantV1;
  closing?: Promise<void>;
  admission: ProcessAdmissionOwner;
  flush?: Promise<void>;
  flushAgain?: boolean;
  events?: ChildEventProcessorV1;
  closed: boolean;
  mailboxResume?: boolean;
  settlingAfterInput?: boolean;
  inputSettlementOwed?: boolean;
  handledInputs?: Set<string>;
  /** 真实结果的结算被存储容量拒绝时的错误；随后的失败收尾据此如实说明，不能标成用户中断。 */
  settlementRejectedForCapacity?: string;
}
function childReply(result: HostResultV1<unknown>): ChildToolReply {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, hostRevision: result.host_revision, correlationId: result.error.correlation_id });
  return { hostRevision: result.host_revision, result: result.value as Readonly<Record<string, unknown>> };
}
function value<T>(result: HostResultV1<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value; }
export class SdkRuntimeControllerV1 {
  async markClickedInbox(details: unknown, content: string): Promise<void> {
    if(!details || typeof details!=="object") return;
    const data=details as Record<string,unknown>, snapshot=this.options.host.snapshot();
    const inbox=[snapshot.root,...snapshot.agents].flatMap(item=>item.inbox).find(inbox=>inbox.inbox_id===data.inbox_id&&inbox.completion_id===data.completion_id&&inbox.projection.projection_sha256===data.projection_sha256&&inbox.projection.content===content);
    if(inbox?.state==="appended"&&inbox.model_entry_id) {
      const result=await this.options.host.markCompletionsRead({receipts:[{inbox_id:inbox.inbox_id,completion_id:inbox.completion_id,projection_sha256:inbox.projection.projection_sha256,entry_id:inbox.model_entry_id}],at:new Date().toISOString()});
      if(!result.ok)this.report("view-read-receipt",new Error(result.error.message));
    }
  }
  async markViewLoaded(agentId: AgentId): Promise<void> {
    const snapshot=this.options.host.snapshot(),agent=snapshot.agents.find(item=>item.agent.agent_id===agentId);
    if(!agent)return;
    const produced=new Set(agent.completions.map(completion=>completion.completion_id));
    const receipts=[snapshot.root,...snapshot.agents].flatMap(item=>item.inbox).filter(inbox=>produced.has(inbox.completion_id)&&inbox.state==="appended"&&!inbox.ui_read_at&&inbox.model_entry_id).map(inbox=>({inbox_id:inbox.inbox_id,completion_id:inbox.completion_id,projection_sha256:inbox.projection.projection_sha256,entry_id:inbox.model_entry_id!}));
    if(!receipts.length)return;
    const result=await this.options.host.markCompletionsRead({receipts,at:new Date().toISOString()});
    if(!result.ok)this.report("view-read-receipt",new Error(result.error.message));
  }
  readonly viewDrafts = new Map<AgentId, string>();
  readonly options: {
    readonly host: AgentHostCoreV1;
    readonly scheduler: RuntimeControllerSchedulerPortV1;
    readonly onTaskSettled?: (input: { readonly agentId: AgentId; readonly taskId: TaskId; readonly completionId: string; readonly outboxId?: string; readonly recipient: Readonly<{ kind: "main" | "agent"; session_id: string; agent_id?: string }> }) => Promise<void>;
    readonly onRootMailbox?: () => Promise<void>;
    readonly reportOperationalError?: (input: { readonly operation: string; readonly error: unknown }) => void;
    agentDir: string; skillPath: string; taskTimeoutMs: number; maxDepth?: 1 | 2;
    settings(): ReturnType<ExtensionAPI["getSettings"]>;
    registry(): ChildCapabilityRegistrySnapshotV1;
    parentEvents?(): ExtensionAPI["events"] | undefined;
  };
  #residents = new Map<AgentId, Resident>();
  #starts = new Set<Promise<void>>();
  #shutdown?: Promise<void>;
  #closed = false;
  #viewAgent?: AgentId;
  #closeView?: (reason: ManagedViewCloseReason) => Promise<void>;
  #viewOpening?: Promise<void>;
  readonly deadlines: TaskDeadlines;
  settingsSources() { return [...this.#residents.keys()].map(agentId => ({ agentId, source: "frozen-profile" })); }
  constructor(options: SdkRuntimeControllerV1["options"]) { this.options = options; this.deadlines = new TaskDeadlines(options.host, async identity => { const state = this.#residents.get(identity.agentId); if (state) await this.abortTask(state, identity); }); }
  private task(state: Resident) { return this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)?.tasks.find(item => item.task_id === state.grant?.taskId); }
  private fence(state: Resident): void {
    const task = this.task(state);
    if (this.#closed || state.closed || this.#residents.get(state.agentId) !== state || !task || task.phase === "settled" || task.runtime_generation !== state.runtimeGeneration
      || this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)?.agent.lifecycle !== "open" || task.interrupt_requested_at || (task.deadline_at_ms !== undefined && Date.now() >= task.deadline_at_ms)) throw Object.assign(new Error("stale-task: child authority has ended"), { code: "stale-task" });
  }
  private caller(state: Resident, requestId: string): Extract<HostCallerV1, { kind: "agent-model" }> {
    const partition = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)!;
    return { kind: "agent-model", conversation: { kind: "agent", session_id: partition.agent.conversation.session_id, agent_id: state.agentId }, runtime_generation: state.runtimeGeneration, owner_request_id: requestId };
  }
  residency(agentId: AgentId) { const state = this.#residents.get(agentId); return state && !state.closed ? { runtimeGeneration: state.runtimeGeneration, state: state.phase === "idle" ? "idle" as const : state.phase === "waiting" ? "waiting" as const : "active" as const, executionReady: state.child !== undefined } : undefined; }
  taskProgress(agentId: AgentId, taskId: TaskId): string | undefined {
    const state = this.#residents.get(agentId);
    const task = state && !state.closed ? this.task(state) : undefined;
    return task?.task_id === taskId && state?.child ? latestTaskProgress(state.child.session.messages, task.started_at) : undefined;
  }
  async childForView(agentId: AgentId): Promise<ChildSession | undefined> {
    const state = this.#residents.get(agentId);
    if (!state || state.closed) return undefined;
    const child = state.child ?? await state.assembly;
    if (state.closed || this.#residents.get(agentId) !== state) return undefined;
    return child;
  }
  async admitViewInput(agentId: AgentId, caller: Extract<HostCallerV1, { kind: "user" }>, message: string, intent: "immediate" | "after-current" = "immediate", requestId = randomUUID()): Promise<Readonly<Record<string, unknown>>> {
    const item = this.options.host.snapshot().agents.find(item => item.agent.agent_id === agentId);
    if (!item) throw new Error("not-found");
    const result = await (intent === "after-current" ? this.options.host.followupTask({ request_id: requestId, caller, input: { target: item.agent.task_path, message } }) : this.options.host.sendInput({ request_id: requestId, caller, input: { target: item.agent.task_path, message } }));
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return { ...result.value };
  }
  inputAccepted(agentId: AgentId): void { void this.flushAgent(agentId).catch(error => this.report("input-delivery", error)); }
  async resumeAgent(agentId: AgentId, generation: number): Promise<void> {
    if (this.#closed || this.#residents.has(agentId)) throw new Error("stale-runtime: execution already exists");
    const partition = this.options.host.snapshot().agents.find(item => item.agent.agent_id === agentId)!;
    const state: Resident = { agentId, runtimeGeneration: generation, phase: "idle", closed: false, admission: undefined as never };
    state.admission = new ProcessAdmissionOwner({ task: () => this.task(state), phase: () => state.phase, resume: async () => { const task = this.task(state); if (task) value(await this.options.host.resumeWaitingTask({ agentId, taskId: task.task_id, runtimeGeneration: generation, at: new Date().toISOString() })); }, requestGrant: () => { const task = this.task(state); if (task) this.options.scheduler.requestActive({ agentId, taskId: task.task_id, admissionOrder: task.activation_order ?? task.admission_order }); } });
    this.#residents.set(agentId, state);
    try {
      const registry = this.options.registry();
      state.assembly = ChildSession.create({ host: this.port(state, registry), profile: partition.agent.profile, registry, agentDir: this.options.agentDir, parentEvents: this.options.parentEvents?.(),
        settings: partition.agent.profile.settings_snapshot, sessionFile: join(this.options.host.options.store.mainRoot, partition.agent.conversation.relative_path),
        systemPromptFile: join(this.options.host.options.store.mainRoot, partition.agent.profile.system_prompt_relative_path), skillPath: this.options.skillPath, taskTimeoutMs: this.options.taskTimeoutMs, maxDepth: this.options.maxDepth });
      state.child = await state.assembly;
      this.options.scheduler.registerIdleRuntime?.({ agentId, runtimeGeneration: generation });
    } catch (error) { state.closed = true; await state.child?.dispose("quit"); this.#residents.delete(agentId); throw error; }
  }
  acquireTaskLease(ownerId: AgentId, taskId: TaskId) {
    const state = this.#residents.get(ownerId);
    if (!state?.child || state.closed) throw new Error("stale-runtime: Task lease owner is unavailable");
    const proof = state.child.conversation.acquireTaskLease(taskId);
    return { ...proof, releaseWithoutWake: async (input: { outcome: "ready" | "failed" | "cancelled" }) => { state.child!.conversation.releaseTaskLease(taskId, input.outcome); } };
  }
  async drainControl(agentId: AgentId): Promise<void> { await this.flushAgent(agentId); await this.#residents.get(agentId)?.flush; }
  async closeAgent(agentId: AgentId): Promise<void> {
    const state = this.#residents.get(agentId); if (!state) return;
    if (this.#viewAgent === agentId) await this.closeView("return");
    if (state.closing) return state.closing;
    state.closing = (async () => {
      const child = state.child ?? await state.assembly?.catch(() => undefined);
      const task = this.task(state), grant = state.startGrant ?? state.grant;
      const held = state.startGrant !== undefined || ["starting", "running", "settling"].includes(state.phase);
      if (task?.runtime_generation && task.phase !== "settled") {
        this.cancelProcessAdmission(state, { taskId: task.task_id, runtimeGeneration: task.runtime_generation });
        await child?.interrupt(task.task_id, task.runtime_generation);
        if (state.phase === "starting" || state.phase === "waiting") await this.settled(state, true);
      }
      if (state.phase === "running") await this.settled(state, true);
      await state.flush;
      // Keep this owner available for already accepted cards/lease ACK, without model work.
      await this.flushAgent(agentId); await state.flush;
      state.closed = true; state.admission.reset("Agent closed");
      if (state.grant) this.deadlines.cancel(agentId, state.grant.taskId);
      await child?.dispose("quit");
      this.#residents.delete(agentId);
      if (held && grant) this.options.scheduler.releaseGrant({ ...grant, nextResidency: "release-residency" });
      this.options.scheduler.retireResident?.({ agentId, runtimeGeneration: state.runtimeGeneration });
    })();
    return state.closing;
  }
  async openView(agentId: AgentId, owner: TerminalOwner, bindingGeneration: number): Promise<void> {
    if (this.#closed || this.#viewAgent) throw new Error("A Subagent view is already open or the owner is closing");
    this.#viewAgent = agentId;
    this.#viewOpening = (async () => {
      const { showSdkChildView } = await import("../ui/sdk-child-view.js");
      await showSdkChildView(this, agentId, owner, bindingGeneration, close => { this.#closeView = close; });
    })();
    try { await this.#viewOpening; }
    finally {
      this.#viewAgent = undefined; this.#closeView = undefined; this.#viewOpening = undefined;
      const resident = this.#residents.get(agentId);
      if (resident?.phase === "idle" && !resident.closed) this.options.scheduler.transitionResident?.({ ...resident.grant!, agentId: resident.agentId, runtimeGeneration: resident.runtimeGeneration,
        state: needsChildControl(this.options.host.snapshot(), agentId) ? "control-pinned" : "idle" });
    }
  }
  async closeView(reason: ManagedViewCloseReason = "return"): Promise<void> {
    // Opening includes first-use imports; wait until the close port is registered.
    while (this.#viewOpening && !this.#closeView) await new Promise(resolve => setTimeout(resolve, 0));
    await this.#closeView?.(reason);
    await this.#viewOpening;
  }
  start(grant: RuntimeStartGrantV1): Promise<void> {
    const start = this.startRuntime(grant);
    this.#starts.add(start);
    return start.finally(() => { this.#starts.delete(start); });
  }
  private assertOwned(state: Resident, grant: RuntimeStartGrantV1): void {
    if (this.#closed || state.closed || this.#residents.get(grant.agentId) !== state || state.grant !== grant) throw new Error("SDK runtime start lost its owner");
  }
  private async startRuntime(grant: RuntimeStartGrantV1): Promise<void> {
    const host = this.options.host, startedAt = new Date().toISOString();
    let state = this.#residents.get(grant.agentId), ownsGrant = false, processResume = false;
    try {
      if (this.#closed) throw new Error("SDK owner is closed");
      const task = host.snapshot().agents.find(item => item.agent.agent_id === grant.agentId)?.tasks.find(item => item.task_id === grant.taskId);
      const resuming = task?.phase === "waiting";
      const activated = task?.activation_order !== undefined;
      if (grant.residency === "existing") {
        if (!state || !["idle", "waiting"].includes(state.phase) || state.runtimeGeneration !== grant.runtimeGeneration) throw new Error("stale-runtime: SDK residency missing");
        processResume = resuming && task.waiting_on?.kind === "process" && state.grant?.taskId === grant.taskId && state.admission.waitingForGrant;
        state.startGrant = grant; state.phase = "starting"; ownsGrant = true;
        if (!processResume) await state.child!.drain();
        if (this.#closed || state.closed || this.#residents.get(grant.agentId) !== state) throw new Error("SDK owner closed before the next Task");
        if (state.grant?.taskId !== grant.taskId) { state.admission.reset("New Task"); state.handledInputs?.clear(); }
        state.grant = grant; state.startGrant = undefined; state.phase = "starting";
      } else {
        if (state) throw new Error("SDK runtime is already resident");
        const resident: Resident = { agentId: grant.agentId, runtimeGeneration: grant.runtimeGeneration, grant, phase: "starting", closed: false, admission: undefined as never };
        resident.admission = new ProcessAdmissionOwner({ task: () => this.task(resident), phase: () => resident.phase,
          resume: async () => { value(await host.resumeWaitingTask({ ...resident.grant!, agentId: resident.agentId, runtimeGeneration: resident.runtimeGeneration, at: new Date().toISOString() })); },
          requestGrant: () => { const current = this.task(resident); if (current) this.options.scheduler.requestActive({ agentId: grant.agentId, taskId: current.task_id, admissionOrder: current.admission_order }); } });
        state = resident; this.#residents.set(grant.agentId, state);
      }
      ownsGrant = true;
      state.activationOrder = task?.activation_order;
      if (!resuming) value(await host.startTask({ ...grant, startedAt }));
      this.assertOwned(state, grant);
      this.deadlines.arm(grant);
      if (!state.child) {
        const partition = host.snapshot().agents.find(item => item.agent.agent_id === grant.agentId)!;
        const settings = partition.agent.profile.settings_snapshot;
        const registry = this.options.registry();
        state.assembly = ChildSession.create({ host: this.port(state, registry), profile: partition.agent.profile, registry, agentDir: this.options.agentDir, parentEvents: this.options.parentEvents?.(),
          settings, newExecution: partition.tasks[0]?.task_id === grant.taskId && grant.runtimeGeneration === 1, maxDepth: this.options.maxDepth, sessionFile: join(host.options.store.mainRoot, partition.agent.conversation.relative_path),
          systemPromptFile: join(host.options.store.mainRoot, partition.agent.profile.system_prompt_relative_path), skillPath: this.options.skillPath, taskTimeoutMs: this.options.taskTimeoutMs });
        state.child = await state.assembly;
        this.assertOwned(state, grant);
        this.options.scheduler.confirmRuntime({ grantId: grant.grantId, runtimeGeneration: grant.runtimeGeneration });
        value(await host.resetSentOwnerEvents({ ...grant, at: new Date().toISOString() }));
        this.assertOwned(state, grant);
      }
      const partition = host.snapshot().agents.find(item => item.agent.agent_id === grant.agentId)!;
      if (!resuming) {
        const usage = await readNativeSessionUsageV1(join(host.options.store.mainRoot, partition.agent.conversation.relative_path));
        this.assertOwned(state, grant);
        value(await host.recordUsageBaseline({ ...grant, usage, at: new Date().toISOString() }));
        this.assertOwned(state, grant);
      }
      if (!activated) value(await (resuming ? host.resumeWaitingTask({ ...grant, at: new Date().toISOString() }) : host.markTaskRunning({ ...grant, at: new Date().toISOString() })));
      this.assertOwned(state, grant);
      state.phase = "running";
      this.fence(state);
      if (processResume) {
        if (activated) value(await host.resumeWaitingTask({ ...grant, at: new Date().toISOString() }));
        state.admission.grant(grant);
        // The old run may be waiting at agent_settled for this exact admission.
        // Only same-Task Process recovery grants before draining that run.
        await state.child!.drain(); this.assertOwned(state, grant); this.fence(state);
      }
      await state.child!.preflight(partition.agent.profile.system_prompt_bytes);
      this.fence(state);
      if (activated) {
        state.mailboxResume = false;
        if (state.admission.waitingForGrant && task?.waiting_on?.kind === "process") {
          value(await host.resumeWaitingTask({ ...grant, at: new Date().toISOString() }));
          state.admission.grant(grant);
        }
        await state.child!.resumeFromCompletions(); void this.flushAgent(grant.agentId); return;
      }
      if (resuming && task?.waiting_on?.kind === "process" && !activated) {
        state.mailboxResume = false;
        if (state.admission.waitingForGrant) state.admission.grant(grant);
        const resumed = state; setTimeout(() => { void this.flushAgent(resumed.agentId); }, 0);
        return;
      }
      const current = state;
      void (resuming ? current.child!.resumeFromCompletions() : current.child!.deliver(this.task(current)!.message))
        .catch(error => this.fail(current, error)).catch(error => this.report("SDK run failure", error));
      void this.flushAgent(grant.agentId);
    } catch (error) {
      if (ownsGrant && state) await this.fail(state, error, this.#closed ? "host-lost" : "protocol-error");
      else this.options.scheduler.releaseGrant({ ...grant, nextResidency: grant.residency === "existing" ? "idle" : "release-residency" });
      if (!this.#closed && host.snapshot().agents.find(item => item.agent.agent_id === grant.agentId)?.agent.lifecycle === "open") throw error;
    }
  }
  private port(state: Resident, registry: ChildCapabilityRegistrySnapshotV1): ChildHostPort {
    const host = this.options.host, partition = host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)!;
    const identity = Object.freeze({ mainSessionId: host.main_session_id, agentId: state.agentId, generation: state.runtimeGeneration,
      sessionId: partition.agent.conversation.session_id, depth: persistentAgentDepth(host.snapshot().agents.map(item => item.agent), state.agentId) });
    return Object.freeze({ identity,
      reloadWhenQuiescent: (inspect, reload) => host.withQuiescentChildReload(state.agentId, () => {
        if (state.closed || this.#closed || this.#residents.get(state.agentId) !== state) return "the execution owner is no longer current";
        if (state.phase !== "idle" || state.flush || state.closing) return "execution control is still active";
        return inspect();
      }, reload),
      checkMail: mail => this.checkMail(state, mail), mailRunEnded: end => {
        if (end.outcome !== "completed") return;
        for (const member of end.members) {
          const prefix = `agent:${state.agentId}:task:${state.grant?.taskId}:gen:${state.runtimeGeneration}:`;
          if (!member.mail.key.startsWith(prefix)) continue;
          for (const message of member.mail.messages) if (message.customType === "subagent-mailbox-v1")
            (state.handledInputs ??= new Set()).add(String((message.details as Record<string, unknown>).message_id));
        }
      }, recordMail: notice => this.recordMail(state, notice), terminalMail: evidence => this.terminalMail(state, evidence),
      executionDisposed: async () => {
        if (state.closing) return state.closing;
        if (this.#closed) return this.#shutdown;
        if (state.closed) return;
        const grant = state.grant, task = this.task(state), phase = state.phase;
        if (grant && task && task.phase !== "settled") {
          state.phase = "settling";
          try {
            const result = value(await host.settleTask({ ...grant, completedAt: new Date().toISOString(), outcome: "failed", reason: "host-lost",
              finalText: "SDK child runtime was externally disposed", summary: "SDK child runtime ended." }));
            this.notify(grant, result);
          } catch (error) { state.phase = phase; throw error; }
        }
        await this.fail(state, new Error("SDK child runtime was externally disposed"), "host-lost");
      },
      viewed: (details,content)=>{void this.markClickedInbox(details,content).catch(error=>this.report("view-read-receipt",error));}, assertInput: items => { this.fence(state); assertMailboxInputAuthority(host.snapshot().agents.find(item=>item.agent.agent_id===state.agentId)!,items,state.runtimeGeneration); }, inputReady: () => { void this.flushAgent(state.agentId); }, ready: () => !state.closed && this.#residents.get(identity.agentId) === state, taskId: () => this.task(state) && this.task(state)?.phase !== "settled" ? state.grant?.taskId ?? "" : "",
      tools: {
        agentDirectory: this.options.agentDir, capabilitySnapshot: registry,
        assertReady: () => this.fence(state), identity: () => ({ ...identity, taskPath: partition.agent.task_path }),
        revision: () => host.host_revision, taskId: () => state.grant?.taskId ?? "",
        acquireTaskLease: taskId => state.child!.conversation.acquireTaskLease(taskId),
        prepare: async ({ requestId, kind, payload, artifacts }) => childReply(await host.prepareOwnerTask({ caller: this.caller(state, requestId), clientOperationId: requestId, kind, payload, preparedArtifacts: artifacts })),
        commit: async ({ requestId, ...input }) => {
          const result = childReply(await host.commitOwnerTask({ caller: this.caller(state, requestId), clientOperationId: requestId, ...input }));
          void this.flushAgent(identity.agentId); return result;
        },
        abort: async ({ requestId, ...input }) => childReply(await host.abortOwnerTask({ caller: this.caller(state, requestId), clientOperationId: requestId, ...input })),
        collaborate: async (tool, input) => {
          const request_id = randomUUID(), caller = this.caller(state, request_id);
          let result: HostResultV1<unknown>;
          if (tool === "close_agent" || tool === "resume_agent") throw new Error("permission-denied: lifecycle tools are Main-only");
          if (tool === "send_input") result = await host.sendInput({ request_id, caller, input: { target: String(input.target), message: String(input.message), ...(input.interrupt !== undefined ? { interrupt: input.interrupt as boolean } : {}) } });
          else if (tool === "wait_agents") result = await host.waitAgents({ request_id, caller, input: { targets: input.targets as string[] } });
          else result = await host.listAgents({ request_id, caller, input: { path_prefix: input.pathPrefix as string | undefined } });
          const reply = childReply(result);
          return reply;
        },
        finish: async input => childReply(await host.recordFinishDeclaration({ ...state.grant!, agentId: state.agentId, runtimeGeneration: state.runtimeGeneration, taskId: input.taskId as TaskId,
          declaration: { outcome: input.outcome as "partial" | "blocked", text: input.text as string, text_sha256: input.textSha256 as string,
            ...(input.reason ? { reason: input.reason as "user-input-required" | "approval-required" | "external-prerequisite" } : {}),
            declared_at: new Date().toISOString(), tool_call_id: input.toolCallId as string, request_id: randomUUID() } })),
      } satisfies ChildToolPort,
      processAdmission: input => state.admission.admit(input),
      recordProcessWait: async ({ taskId, blocking }) => { value(await host.recordProcessWaitState({ ...state.grant!, agentId: state.agentId, runtimeGeneration: state.runtimeGeneration, taskId: taskId as TaskId, blocking, at: new Date().toISOString() })); state.admission.beginWait(); },
      settled: ({ taskId, aborted }) => taskId === state.grant?.taskId ? this.settled(state, aborted) : Promise.resolve(), report: error => this.report("SDK child", error),
      interrupt: () => this.requestInterrupt(identity.agentId, identity.generation),
      shutdown: () => { setTimeout(() => { void this.fail(state, new Error("Child session requested shutdown"), "user-interrupt").catch(error => this.report("child shutdown", error)); }, 0); },
    } satisfies ChildHostPort);
  }
  private checkMail(state: Resident, mail: Mail): CurrentDecision {
    const partition = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId);
    if (!partition) return { kind: "hold", reason: "child source is unavailable" };
    if (mail.key.startsWith("card:")) {
      const inbox = partition.inbox.find(item => `card:${item.inbox_id}` === mail.key);
      if (!inbox || canonicalJsonV1(mail.messages) !== canonicalJsonV1([{ customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
        details: { inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, completion_details: JSON.parse(inbox.projection.details_json) } }]))
        throw new Error("child Completion source projection conflict");
      return { kind: "allow", project: true, wake: false };
    }
    const key = /^agent:([^:]+):task:([^:]+):gen:(\d+):(.+)$/u.exec(mail.key);
    if (!key || key[1] !== state.agentId) return { kind: "hold", reason: "unknown child source key" };
    if (Number(key[3]) !== state.runtimeGeneration || partition.agent.lifecycle !== "open") return { kind: "cancel", reason: "child generation ended" };
    if (key[2] === "idle") return { kind: "allow", project: true, wake: false };
    const task = partition.tasks.find(item => item.task_id === key[2]);
    if (!task || task.phase === "settled" || task.finish_declaration || task.interrupt_requested_at || task.runtime_generation !== state.runtimeGeneration
      || partition.agent.current_task_id !== task.task_id) return { kind: "cancel", reason: "child Task authority ended" };
    if (task.deadline_at_ms !== undefined && Date.now() >= task.deadline_at_ms) return { kind: "cancel", reason: "child Task deadline ended" };
    const details = mail.messages[0]?.details as Record<string, unknown>;
    if (mail.messages[0]?.customType === "subagent-mailbox-v1") {
      if (typeof mail.messages[0].content !== "string" || createHash("sha256").update(mail.messages[0].content).digest("hex") !== details.body_sha256)
        throw new Error("child mailbox body hash mismatch");
      try { assertMailboxInputAuthority(partition, [{ messageId: String(details.message_id), body: String(mail.messages[0].content), bodySha256: String(details.body_sha256), injectedInto: details.injected_into as never }], state.runtimeGeneration); }
      catch (error) { return { kind: "cancel", reason: String(error) }; }
    }
    if (key[4]!.startsWith("outbox:")) {
      const identity = /^outbox:([^:]+):(\d+)(:continuation)?$/u.exec(key[4]!);
      const snapshot = this.options.host.snapshot();
      const source = [snapshot.root, ...snapshot.agents].flatMap(item => item.outbox).find(item => item.outbox_id === identity?.[1]);
      const epoch = Number(identity?.[2]);
      if (!source || source.recipient.agent_id !== state.agentId || !Number.isSafeInteger(epoch) || epoch < 1) return { kind: "hold", reason: "child Outbox authority is unavailable" };
      const authorizedEpoch = source.wake_epoch === epoch || partition.owner_events.some(event => event.kind === "release_task_lease"
        && !["acked", "cancelled"].includes(event.state) && (() => { const payload = JSON.parse(event.payload_json); return payload.outboxId === source.outbox_id && payload.wakeEpoch === epoch; })());
      if (!authorizedEpoch) return { kind: "cancel", reason: "child Outbox epoch ended" };
      let expected: unknown[];
      if (identity?.[3]) expected = [{ customType: "subagent-continuation-v1", content: `Subagent results ${source.completion_ids.join(", ")} are ready. Continue from the delivered completion cards.`, display: false,
        details: { version: 1, outbox_id: source.outbox_id, wake_epoch: epoch, completion_ids: source.completion_ids } }];
      else expected = source.completion_ids.map(id => {
        const inbox = partition.inbox.find(item => item.completion_id === id);
        if (!inbox) throw new Error("child Outbox card source is unavailable");
        return { customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
          details: { inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, completion_details: JSON.parse(inbox.projection.details_json) } };
      });
      if (canonicalJsonV1(mail.messages) !== canonicalJsonV1(expected)) throw new Error("child Outbox source projection conflict");
    }
    return { kind: "allow", project: true, wake: mail.wake && ["running", "waiting"].includes(task.phase) && state.phase === "running" && state.grant?.taskId === task.task_id };
  }
  private async recordMail(state: Resident, notice: RecordedNotice): Promise<void> {
    if (state.closed || !state.child) throw new Error("child source is detached");
    // Do not await a proof inside the owner-event loop. Finish its pending
    // observation, then replay the durable event using A's native evidence.
    await state.flush;
    await this.flushAgent(state.agentId); await state.flush;
    const partition = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)!;
    const entryId = notice.entries[0]?.entryId;
    if (!entryId) throw new Error("child native proof is incomplete");
    if (notice.key.startsWith("card:")) {
      const inbox = partition.inbox.find(item => `card:${item.inbox_id}` === notice.key);
      if (inbox?.state === "appended" && inbox.model_entry_id === entryId) return;
    } else if (notice.key.includes(":outbox:")) {
      const source = [this.options.host.snapshot().root, ...this.options.host.snapshot().agents].flatMap(item => item.outbox)
        .find(item => notice.key.endsWith(`:outbox:${item.outbox_id}:${item.wake_epoch}`) || notice.key.endsWith(`:outbox:${item.outbox_id}:${item.wake_epoch}:continuation`));
      if (source && ["delivered", "delivery-failed"].includes(source.state)) return;
    } else if (partition.mailbox.some(item => notice.key.endsWith(`:${item.message_id}`) && (item.state === "cancelled" || item.session_entry_id === entryId && ["injected", "consumed"].includes(item.state)))) return;
    throw new Error("child source native ACK remains pending");
  }
  private async terminalMail(state: Resident, evidence: TerminalEvidence): Promise<void> {
    if (evidence.outcome === "fulfilled") return;
    const partition = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId);
    const key = /^agent:([^:]+):task:([^:]+):gen:(\d+):/u.exec(evidence.key);
    const task = partition?.tasks.find(item => item.task_id === key?.[2]);
    if (partition && (partition.agent.lifecycle !== "open" || Number(key?.[3]) !== partition.agent.runtime_generation || task?.phase === "settled"
      || task?.interrupt_requested_at || task?.finish_declaration)) return;
    throw new Error("child source cancellation remains pending");
  }
  async cancelTaskMail(input: { agentId: AgentId; taskId: TaskId; runtimeGeneration: number }): Promise<void> {
    const state = this.#residents.get(input.agentId);
    if (!state || state.closed || state.runtimeGeneration !== input.runtimeGeneration) return;
    this.cancelProcessAdmission(state, input);
    await state.child?.cancelTaskMail(input.taskId, input.runtimeGeneration);
  }
  /** Host-owned self-interrupt port; independent of view attachment and Main binding replacement. */
  async requestInterrupt(agentId: AgentId, generation?: number): Promise<void> {
    const state = this.#residents.get(agentId);
    if (this.#closed || !state || state.closed || generation !== undefined && state.runtimeGeneration !== generation) return;
    const task = this.task(state), host = this.options.host;
    if (task?.runtime_generation && ["starting", "running", "waiting"].includes(task.phase)) {
      value(await host.interruptAgent({ request_id: randomUUID(), caller: { kind: "user", main_session_id: host.main_session_id,
        binding_generation: host.binding_generation, manager_generation: host.options.managerGeneration ?? 1 },
        input: { target: agentId, expected_task_id: task.task_id, expected_runtime_generation: task.runtime_generation } }));
    }
    if (state.child?.session.isCompacting) state.child.session.abortCompaction();
  }
  async interrupt(input: { agentId: AgentId; taskId: TaskId; runtimeGeneration: number }): Promise<void> {
    const state = this.#residents.get(input.agentId);
    if (!state) return;
    // Host may hold its transaction queue; the authority fence belongs inside the callback.
    setTimeout(() => { void this.abortTask(state, input).catch(error => this.report("SDK interrupt", error)); }, 0);
  }
  private cancelProcessAdmission(state: Resident, input: { taskId: TaskId; runtimeGeneration: number }): void {
    if (state.closed || this.#residents.get(state.agentId) !== state || state.grant?.taskId !== input.taskId || state.runtimeGeneration !== input.runtimeGeneration) return;
    state.admission.cancel(input);
    state.child?.cancelProcessAdmission(input.taskId, input.runtimeGeneration);
  }
  private async abortTask(state: Resident, input: { agentId: AgentId; taskId: TaskId; runtimeGeneration: number }): Promise<void> {
    const current = () => !state.closed && this.#residents.get(input.agentId) === state && state.grant?.taskId === input.taskId && state.runtimeGeneration === input.runtimeGeneration;
    const task = current() ? this.task(state) : undefined;
    if (!task || task.phase === "settled" || !task.interrupt_requested_at || task.interrupt_generation !== input.runtimeGeneration) return;
    this.cancelProcessAdmission(state, input);
    await state.child?.interrupt(input.taskId, input.runtimeGeneration);
    if (current() && state.phase === "waiting") await this.settled(state, true);
  }
  private async settled(state: Resident, aborted: boolean): Promise<void> {
    if (state.closed || !["starting", "running", "waiting"].includes(state.phase)) return;
    const task = this.task(state); if (!task || task.phase === "settled") return;
    const activationOrder = state.activationOrder;
    state.inputSettlementOwed = false;
    const parked = state.phase === "waiting";
    const partition = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)!;
    const pendingInput = partition.mailbox.some(mail => mail.task_id === task!.task_id && mail.state !== "cancelled"
      && (mail.state === "pending" || !state.handledInputs?.has(mail.message_id)));
    // Native ACK can beat agent_settled without the input being in that run's
    // request. Keep its active grant until A reports the actual input run;
    // parking here would strand an injected/sent intent with wake=false.
    if (!aborted && !task.interrupt_requested_at && !task.finish_declaration && pendingInput) { state.inputSettlementOwed = true; void this.flushAgent(state.agentId); return; }
    // Process lease release precedes its durable notification/admission. Only
    // the bridge may resume that Task; a mailbox run cannot infer completion
    // from an absent lease and settle before the Process batch is consumed.
    const dependencyReady = task.waiting_on?.kind === "agent-barrier" && partition.barrier?.state === "satisfied";
    if (task.phase === "waiting" && !dependencyReady && !aborted && !task.interrupt_requested_at && !task.finish_declaration) {
      if (!parked) this.options.scheduler.releaseGrant({ ...state.grant!, runtimeGeneration: state.runtimeGeneration, nextResidency: "waiting-pinned" });
      value(await this.options.host.finishWaitingActivation({ agentId: state.agentId, taskId: task.task_id, runtimeGeneration: state.runtimeGeneration, expectedActivationOrder: activationOrder, at: new Date().toISOString() }));
      state.phase = "waiting"; state.mailboxResume = false; void this.flushAgent(state.agentId); return;
    }
    if (!aborted && !task.finish_declaration && task.phase === "running") {
      const pending = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)?.mailbox.some(mail => mail.task_id === task!.task_id && mail.state === "pending");
      if (pending) {
        // Keep the current grant and Task identity while the native steer is consumed.
        state.inputSettlementOwed = true; void this.flushAgent(state.agentId);
        return;
      }
    }
    if (task.phase === "waiting" && dependencyReady && !aborted && !task.interrupt_requested_at) value(await this.options.host.resumeWaitingTask({ ...state.grant!, at: new Date().toISOString() }));
    state.phase = "settling";
    const proof = await readNativeTerminalProofV1({ mainRoot: this.options.host.options.store.mainRoot, state: this.options.host.snapshot(), ...state.grant!, aborted });
    if (!proof) { state.phase = "running"; throw new Error("native terminal proof is unavailable at agent_settled"); }
    const settledResult = await this.options.host.settleTask({ ...state.grant!, agentId: state.agentId, runtimeGeneration: state.runtimeGeneration, ...proof });
    if (!settledResult.ok && settledResult.error.code === "input-pending") { state.phase = "running"; void this.flushAgent(state.agentId); return; }
    if (!settledResult.ok && settledResult.error.code === "storage-capacity") state.settlementRejectedForCapacity = settledResult.error.message;
    const settled = value(settledResult);
    if (state.grant) this.deadlines.cancel(state.agentId, state.grant.taskId);
    state.admission.reset("Task settled");
    state.phase = "idle";
    const pinned = needsChildControl(this.options.host.snapshot(), state.agentId);
    if (parked) this.options.scheduler.transitionResident?.({ ...state.grant!, agentId: state.agentId, runtimeGeneration: state.runtimeGeneration, state: pinned ? "control-pinned" : "idle" });
    else this.options.scheduler.releaseGrant({ ...state.grant!, runtimeGeneration: state.runtimeGeneration, nextResidency: pinned ? "control-pinned" : "idle" });
    this.notify(state.grant!, settled); void this.flushAgent(state.agentId);
  }
  private notify(grant: RuntimeStartGrantV1, settled: { completion_id: string; outbox_id?: string; recipient: { kind: "main" | "agent"; session_id: string; agent_id?: string } }): void {
    const timer = setTimeout(() => { void this.options.onTaskSettled?.({ ...grant, completionId: settled.completion_id, outboxId: settled.outbox_id, recipient: settled.recipient }).catch(error => this.report("SDK completion delivery", error)); }, 0); timer.unref?.();
  }
  async flushAgent(agentId: AgentId): Promise<boolean> {
    const state = this.#residents.get(agentId); if (!state?.child || state.closed) return false;
    if (state.flush) { state.flushAgain = true; return true; }
    state.flushAgain = false;
    state.flush = this.flush(state).catch(error => { if (!(error instanceof DeliveryPending)) this.report("SDK delivery", error); }).finally(() => {
      state.flush = undefined;
      const task = this.task(state), item = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId);
      if (!state.closed && state.inputSettlementOwed && state.phase === "running" && ["running", "waiting"].includes(task?.phase ?? "") && item?.mailbox.some(mail => mail.task_id === task!.task_id) && !item.mailbox.some(mail => mail.task_id === task!.task_id && mail.state === "pending")
        && item.mailbox.filter(mail => mail.task_id === task!.task_id && mail.state !== "cancelled").every(mail => state.handledInputs?.has(mail.message_id)) && !state.settlingAfterInput) {
        state.settlingAfterInput = true;
        void state.child!.drain().then(() => { if (!state.closed && state.phase === "running") return this.settled(state, false); }).catch(error => this.report("input-settlement", error)).finally(() => { state.settlingAfterInput = false; });
      }
      if (state.flushAgain && !state.closed) void this.flushAgent(agentId);
    });
    return true;
  }
  private async flush(state: Resident): Promise<void> {
    if (state.child!.session.isCompacting) return;
    const host = this.options.host, caller = this.caller(state, randomUUID());
    const processor = state.events ??= new ChildEventProcessorV1({
      acquireTaskLease: taskId => state.child!.conversation.acquireTaskLease(taskId),
      taskLease: taskId => state.child!.conversation.taskLease(taskId),
      releaseTaskLease: (taskId, outcome) => state.child!.conversation.releaseTaskLease(taskId, outcome),
      releaseTaskLeaseWithWake: input => state.child!.conversation.releaseTaskLeaseWithWake(input),
      finalizeWakeProof: (outboxId, wakeEpoch) => state.child!.conversation.finalizeWakeProof(outboxId, wakeEpoch),
      activeLeaseTaskIds: () => state.child!.conversation.activeLeaseTaskIds(),
      appendCompletionCards: items => state.child!.conversation.appendCompletionCards(items),
      appendMailboxMessages: items => state.child!.conversation.appendMailboxMessages(items),
      identity: () => ({ runtimeGeneration: state.runtimeGeneration, parentConversationSessionId: caller.conversation.session_id }),
      apply: async (_kind, payload) => ({ result: value(await host.persistOwnerEventApplication({ caller, requestId: randomUUID(), eventId: String(payload.eventId), eventSequence: Number(payload.eventSequence), eventPayloadSha256: String(payload.eventPayloadSha256), runtimeGeneration: state.runtimeGeneration, result: payload, at: new Date().toISOString() })) }),
      ack: async payload => ({ result: value(await host.ackOwnerEvents({ caller, ...payload, at: new Date().toISOString() })) }), pendingRequestIds: () => [] });
    for (let pass = 0; pass < 32 && !state.closed; pass++) {
      if (["idle", "waiting"].includes(state.phase)) {
        const snapshot = host.snapshot();
        const outboxes = [snapshot.root, ...snapshot.agents].flatMap(item => item.outbox).filter(item => item.recipient.agent_id === state.agentId);
        for (const outbox of outboxes) {
          if (["pending", "delivering"].includes(outbox.state)) value(await host.synthesizeCompletionDelivery({ outboxId: outbox.outbox_id, at: new Date().toISOString() }));
          if (outbox.state === "cards-appended" && outbox.wake_state === "not-offered") value(await host.synthesizeSettledLeaseRelease({ outboxId: outbox.outbox_id, at: new Date().toISOString() }));
        }
      }
      value(await host.synthesizeMailboxDelivery({ agentId: state.agentId, at: new Date().toISOString() }));
      const waiting = this.task(state);
      const unhandledInput = host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)?.mailbox.some(mail => mail.task_id === waiting?.task_id
        && mail.state !== "cancelled" && (mail.state === "pending" || !state.handledInputs?.has(mail.message_id)));
      if (state.phase === "waiting" && waiting?.activation_order !== undefined && (hasTaskMailbox(host.snapshot(), state.agentId) || unhandledInput)) {
        if (!state.mailboxResume && !state.admission.waitingForGrant) {
          state.mailboxResume = true;
          this.options.scheduler.requestActive({ agentId: state.agentId, taskId: waiting.task_id, admissionOrder: waiting.activation_order ?? waiting.admission_order });
        }
        return;
      }
      const retained = host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)?.owner_events.find(event => event.state === "sent" && event.target_runtime_generation === state.runtimeGeneration);
      const events = retained ? [retained] : value(await host.sendOwnerEvents({ ...state.grant!, agentId: state.agentId, runtimeGeneration: state.runtimeGeneration, at: new Date().toISOString(), limit: 1 })).events;
      if (!events.length) {
        if (state.phase === "idle") this.options.scheduler.transitionResident?.({ ...state.grant!, agentId: state.agentId, runtimeGeneration: state.runtimeGeneration, state: needsChildControl(host.snapshot(), state.agentId) ? "control-pinned" : "idle" });
        return;
      }
      for (const event of events) await processor.process({ eventSequence: event.event_sequence, payload: { eventId: event.event_id, eventKind: event.kind, eventPayloadSha256: event.payload_sha256, payload: JSON.parse(event.payload_json) } });
    }
    state.flushAgain = true;
  }
  private fail(state: Resident, error: unknown, reason: "protocol-error" | "host-lost" | "user-interrupt" = "protocol-error"): Promise<void> {
    if (state.closing) return state.closing;
    const grant = state.grant, executionGrant = state.startGrant ?? grant, heldGrant = state.startGrant !== undefined || ["starting", "running", "settling"].includes(state.phase);
    return state.closing = (async () => {
      const child = state.child ?? await state.assembly?.catch(() => undefined);
      if (grant) this.cancelProcessAdmission(state, grant);
      if (!this.#closed && reason !== "host-lost" && grant) await child?.cancelTaskMail(grant.taskId, state.runtimeGeneration);
      state.closed = true; if (grant) this.deadlines.cancel(grant.agentId, grant.taskId); state.admission.reset("Runtime failed");
      await child?.dispose("quit");
      await state.flush;
      const task = this.task(state);
      if (grant && task && task.phase !== "settled") { const result = await this.options.host.settleTask({ ...grant, completedAt: new Date().toISOString(), ...(state.settlementRejectedForCapacity ? this.capacityFallback(state) : { outcome: reason === "user-interrupt" ? "interrupted" : "failed", reason, finalText: String(error).slice(0, 4096), summary: "SDK child runtime ended." }) }); if (result.ok) if (grant) this.notify(grant, result.value); }
      if (this.#residents.get(state.agentId) === state) this.#residents.delete(state.agentId);
      if (heldGrant && executionGrant) this.options.scheduler.releaseGrant({ ...executionGrant, nextResidency: "release-residency" });
      this.options.scheduler.retireResident?.({ agentId: state.agentId, runtimeGeneration: state.runtimeGeneration });
    })();
  }
  /** 真实结果存不进去时的卡片：如实说是存储容量问题，指向子 Agent 会话里的完整输出。 */
  private capacityFallback(state: Resident): { outcome: "failed"; reason: "storage-error"; finalText: string; summary: string } {
    const agent = this.options.host.snapshot().agents.find(item => item.agent.agent_id === state.agentId)?.agent;
    const session = agent ? join(this.options.host.options.store.mainRoot, agent.conversation.relative_path) : undefined;
    return { outcome: "failed", reason: "storage-error",
      finalText: `子 Agent 已经结束，但它的结果因 Subagents 存储容量不足没能保存（${state.settlementRejectedForCapacity}）。结果没有丢：完整输出在子 Agent 会话里，用 /subagents ${state.agentId} 打开${session ? `，或直接读 ${session}` : ""}。删除已结算的子 Agent 子树腾出空间后，可以让它再汇报一次。`.slice(0, 4096),
      summary: "结果因存储容量不足没能保存，完整输出在子 Agent 会话里。" };
  }
  shutdown(): Promise<void> {
    this.#closed = true; this.deadlines.dispose();
    return this.#shutdown ??= (async () => {
      await this.closeView("quit");
      await Promise.all([...this.#residents.values()].map(state => this.fail(state, new Error("Main process is shutting down"), "host-lost")));
      await Promise.allSettled([...this.#starts]);
    })();
  }
  private report(operation: string, error: unknown): void { this.options.reportOperationalError?.({ operation, error }); }
}
