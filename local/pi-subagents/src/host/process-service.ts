import { readMainMailboxRetirement } from "../mailbox/retirement-main.js";
import { mainImportDeliverySnapshot, mainOutboxImportHold } from "../mailbox/main-import-scope.js";
import { finishMainOutboxMail, importMainMailbox } from "../mailbox/import-main.js";
import { DeliveryPending } from "../mailbox/transport.js";
import type { SubagentMailboxTransport } from "../mailbox/transport.js";
import type { TerminalOwner } from "pi-session-runtime/terminal-owner";
import { SdkRuntimeControllerV1 } from "../runtime/sdk-controller.js";
import { mainKey } from "../domain/ids.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queryGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import { getContinuationRegistryV1 } from "pi-runtime-contracts/continuation-v1";
import { openMainStoreV1, type MainStoreV1 } from "../persistence/store.js";
import { collectInboxTranscriptProofsV1 } from "../persistence/inbox-proofs.js";
import { getOrCreateRuntimeCoordinatorCellV1, type RuntimeCoordinatorClaimV1 } from "../scheduler/global.js";
import { getOrCreateChildCapabilityRegistryV1 } from "../capabilities/registry.js";
import { getOrCreateProducerProofRegistryV1 } from "./producer-proof.js";
import { AgentHostCoreV1 } from "./core.js";
import { SchedulerAdapterV1 } from "./scheduler-adapter.js";
import { MainSpawnPreparationV1 } from "./main-spawn-preparation.js";
import { MainSessionAppendPortV1 } from "./main-append-port.js";
import { DeliveryEngineV1, driveOutboxDeliveryV1, reconcileMainDeliveryV1 } from "./delivery-engine.js";
import { MainTurnSettlementV1 } from "./main-turn-settlement.js";
import { createMainCollaborationExecutorV1 } from "./main-executor.js";
import type { CollaborationExecutorV1 } from "../tools/register.js";
import type { SubagentsConfigV1 } from "../config/types.js";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); const SKILL = join(PACKAGE_ROOT, "skills", "subagents", "SKILL.md");
export interface ProcessMainBindingV1 { mailboxImportPending?: boolean; mailboxImportHolds?: ReadonlyMap<string, string>; terminalOwner?: TerminalOwner; readonly mainSessionId: string; config: SubagentsConfigV1; readonly host: AgentHostCoreV1; readonly store: MainStoreV1; readonly preparation: MainSpawnPreparationV1; readonly runtime: SdkRuntimeControllerV1; settings: ReturnType<ExtensionAPI["getSettings"]>; capabilitySnapshot: ReturnType<ReturnType<typeof getOrCreateChildCapabilityRegistryV1>["snapshot"]>; readonly scheduler: SchedulerAdapterV1; delivery: DeliveryEngineV1; readonly turn: MainTurnSettlementV1; bindingGeneration: number; pi?: ExtensionAPI; context?: ExtensionContext; append?: MainSessionAppendPortV1; idleWaiters: Set<{resolve():void;reject(error:Error):void}> }
export class SubagentProcessServiceV1 {
  readonly config: SubagentsConfigV1;
  readonly agentDirectory: string;
  readonly coordinatorClaim: RuntimeCoordinatorClaimV1;
  #mains = new Map<string, ProcessMainBindingV1>();
  #reconciling = new Map<string, { requested: boolean }>();
  #turnSettling = new Map<string, Promise<void>>();
  #foregroundSessionId?: string;
  #rootMailboxPass?: Promise<void>;
  #diagnostics: Array<{ at: string; operation: string; message: string }> = [];
  #closed = false;
  private constructor(input: { config: SubagentsConfigV1; agentDirectory: string; claim: RuntimeCoordinatorClaimV1 }) {
    this.config = input.config; this.agentDirectory = input.agentDirectory; this.coordinatorClaim = input.claim;
  }
  static async create(input: { config: SubagentsConfigV1; agentDirectory: string }): Promise<SubagentProcessServiceV1> {
    const agentDirectory = await realpath(input.agentDirectory);
    const claim = getOrCreateRuntimeCoordinatorCellV1().claim({ ownerGeneration: Date.now(), processLimits: { activeTasksPerProcess: input.config.capacity.activeTasksPerProcess } });
    getOrCreateProducerProofRegistryV1();
    return new SubagentProcessServiceV1({ ...input, agentDirectory, claim });
  }
  async attach(pi: ExtensionAPI, ctx: ExtensionContext, config: SubagentsConfigV1 = this.config, mailbox: SubagentMailboxTransport): Promise<ProcessMainBindingV1> { if (this.#closed) throw new Error("Subagent process service is closed"); const sessionId = ctx.sessionManager.getSessionId(); this.#foregroundSessionId = sessionId; let binding = this.#mains.get(sessionId); if (binding) { binding.mailboxImportPending = true; binding.bindingGeneration++; binding.host.replaceBinding(binding.bindingGeneration); binding.host.reopenBinding(); binding.scheduler.resume(); binding.config = config; binding.host.updatePolicy({ maxDepth: config.execution.maxDepth, openAgentsPerMain: config.capacity.openAgentsPerMain }); binding.runtime.options.maxDepth = config.execution.maxDepth; binding.preparation.updateMaxDepth(config.execution.maxDepth); this.coordinatorClaim.coordinator.updateHostLimits(binding.scheduler.token, { activeTasksPerMain: config.capacity.activeTasksPerMain }); binding.preparation.updatePi(pi); binding.settings = structuredClone(pi.getSettings()); binding.capabilitySnapshot = getOrCreateChildCapabilityRegistryV1().snapshot(sessionId); binding.pi = pi; binding.context=ctx; binding.append = new MainSessionAppendPortV1(ctx.sessionManager, mailbox); binding.host.mainMailboxReadContext = binding.store.mainMailboxReadContext = { agentDirectory: this.agentDirectory, session: ctx.sessionManager, transport: mailbox }; // The new runner binds its idle callbacks after session_start returns.
      await this.settleMainTurn(binding);
      const imported = await importMainMailbox(pi, ctx, binding, mailbox);
      this.finishMailboxImport(binding, imported, ctx);
      setTimeout(() => { if (binding?.pi === pi && binding.context === ctx) this.signalMainIdle(sessionId); }, 0).unref(); return binding; } const agentDirectory=this.agentDirectory,storeRoot=join(agentDirectory,"pi-subagents","store-v2","mains",mainKey(sessionId));const store = await openMainStoreV1({ agentDirectory, mainSessionId: sessionId, mailboxImport: true, mainMailboxReadContext: { agentDirectory: this.agentDirectory, session: ctx.sessionManager, transport: mailbox }, limits: { maxStoreBytesPerMain: config.storage.maxStoreBytesPerMain, maxStoreBytesPerProcess: this.config.storage.maxStoreBytesPerProcess, maxMetadataBytesPerMain: config.storage.maxMetadataBytesPerMain }, liveRuntimeGenerations: new Map(), preparedLeaseRecovery: { releaseIntent: async (intent) => { const held = getContinuationRegistryV1().snapshot(intent.session_id).blocking.some((item) => item.ownerId === "pi-subagents" && item.logicalKey === intent.logical_key); if (held) this.report("prepared-lease-recovery", new Error(`prepared lease intent ${intent.logical_key} is still held in this process`)); } },inboxProofProvider:state=>collectInboxTranscriptProofsV1({state,mainRoot:storeRoot,mainSessionManager:ctx.sessionManager}) }); let runtime!: SdkRuntimeControllerV1; let scheduler!: SchedulerAdapterV1; const preparation = new MainSpawnPreparationV1({ pi, agentDirectory: this.agentDirectory, skillPath: SKILL, taskTimeoutMs: config.execution.taskTimeoutMs, maxDepth: config.execution.maxDepth }); const leaseRegistry = getContinuationRegistryV1(); const runtimeProxy = { cancelTaskMail: (input: { agentId: import("../domain/types.js").AgentId; taskId: import("../domain/types.js").TaskId; runtimeGeneration: number }) => runtime.cancelTaskMail(input), residency: (agentId: never) => runtime?.residency(agentId), drainControl: (id: import("../domain/types.js").AgentId) => runtime.drainControl(id), resumeAgent: (id: import("../domain/types.js").AgentId, generation: number) => runtime.resumeAgent(id, generation), closeAgent: (id: import("../domain/types.js").AgentId) => runtime.closeAgent(id), inputAccepted: (id: import("../domain/types.js").AgentId) => runtime.inputAccepted(id), interrupt: (value: never) => runtime.interrupt(value) }; const schedulerProxy = { cancelAgent: (id: import("../domain/types.js").AgentId) => scheduler.cancelAgent(id), taskAdmitted: (value: never) => scheduler.taskAdmitted(value) }; const host = new AgentHostCoreV1({ mainSessionId: sessionId, instanceGeneration: 1, bindingGeneration: 1, config: { openAgentsPerMain: config.capacity.openAgentsPerMain, maxDepth: config.execution.maxDepth, maxTasksPerAgent: config.storage.maxTasksPerAgent, maxTasksPerMain: config.storage.maxTasksPerMain, maxMailboxRecordsPerConversation: config.storage.maxMailboxRecordsPerConversation }, store, spawnPreparation: preparation, runtime: runtimeProxy, scheduler: schedulerProxy, leases: { acquire: async ({ owner, sessionId: leaseSession, taskId, reason }) => { if (owner.kind === "agent") return runtime.acquireTaskLease(owner.agent_id!, taskId); const acquired = leaseRegistry.acquireBlocking({ sessionId: leaseSession, ownerId: "pi-subagents", logicalKey: taskId, reason }); if (!acquired.ok) throw new Error(acquired.error); return { leaseId: acquired.value.snapshot().leaseId, generation: acquired.value.snapshot().generation, releaseWithoutWake: async (release) => { const result = acquired.value.releaseWithoutWake(release); if (!result.ok) throw new Error(result.error); }, releaseAndOfferWake: (release) => { const result = acquired.value.releaseAndOfferWake(release); if (!result.ok) throw new Error(result.error); return result.value as never; } }; } }, reportOperationalError: ({ operation, error }) => this.report(operation, error) }); runtime = new SdkRuntimeControllerV1({ host, agentDir: this.agentDirectory, skillPath: SKILL, taskTimeoutMs: config.execution.taskTimeoutMs, maxDepth: config.execution.maxDepth,
      settings: () => binding!.settings, registry: () => getOrCreateChildCapabilityRegistryV1().snapshot(sessionId), parentEvents: () => binding!.pi?.events,
      scheduler: { registerIdleRuntime: value => scheduler.registerIdleRuntime(value), confirmRuntime: value => scheduler.confirmRuntime(value), retireResident: value => scheduler.retireResident(value), transitionResident: value => scheduler.transitionResident(value), releaseGrant: value => scheduler.releaseGrant(value), requestActive: value => scheduler.requestActive(value) },
      onTaskSettled: settled => this.deliverSettlement(binding!, settled), onRootMailbox: () => this.deliverRootMailbox(binding!), reportOperationalError: ({ operation, error }) => this.report(operation, error),
    }); const persistedGenerations = new Map<string, number>(); for (const partition of store.snapshot().agents) { let highest = partition.agent.runtime_generation; for (const task of partition.tasks) if (Number.isSafeInteger(task.runtime_generation) && (task.runtime_generation ?? 0) > highest) highest = task.runtime_generation!; if (highest > 0) persistedGenerations.set(partition.agent.agent_id, highest); } scheduler = new SchedulerAdapterV1({ coordinator: this.coordinatorClaim.coordinator, mainSessionId: sessionId, hostGeneration: 1, initialRuntimeGenerations: persistedGenerations, limits: { activeTasksPerMain: config.capacity.activeTasksPerMain }, onGrant: async(grant) => { try{if(this.#closed)throw new Error("Subagent process service is closed");}catch(error){scheduler.releaseGrant({grantId:grant.grantId,coordinatorGeneration:grant.coordinatorGeneration,runtimeGeneration:grant.runtimeGeneration,nextResidency:"release-residency"});throw error;}await runtime.start(grant); }, report: ({ operation, error }) => this.report(operation, error) }); binding = { mailboxImportPending: true, settings: structuredClone(pi.getSettings()), capabilitySnapshot: getOrCreateChildCapabilityRegistryV1().snapshot(sessionId), mainSessionId: sessionId, config, host, store, preparation, runtime, scheduler, delivery: undefined as never, turn: new MainTurnSettlementV1(), bindingGeneration: 1, pi, context:ctx, idleWaiters:new Set(), append: undefined }; binding.append=new MainSessionAppendPortV1(ctx.sessionManager, mailbox); host.mainMailboxReadContext = store.mainMailboxReadContext = { agentDirectory: this.agentDirectory, session: ctx.sessionManager, transport: mailbox }; binding.delivery = new DeliveryEngineV1({ host,
      tryHandleOutbox: outboxId => binding!.turn.settleHandled({ host, mainSessionId: sessionId, outboxId,
        branch: () => binding?.append?.session.getBranch() ?? [], at: new Date().toISOString() }), resolveAppendPort: (recipient) => recipient.kind === "main" && binding?.append?.conversation.session_id === recipient.session_id ? binding.append : undefined, offerWake: (offer) => { const created = leaseRegistry.offerWake({ sessionId: offer.sessionId, ownerId: "pi-subagents", logicalKey: offer.logicalKey, reason: offer.reason, outcome: offer.outcome }); if (!created.ok) throw new Error(created.message); return created.value as never; }, producerProofRegistry: getOrCreateProducerProofRegistryV1(), ownerToken: `main:${sessionId}`, ownerGeneration: 1 }); this.#mains.set(sessionId,binding);await host.recoverRootTaskLeases();
    await this.settleMainTurn(binding);
    const imported = await importMainMailbox(pi, ctx, binding, mailbox);
    this.finishMailboxImport(binding, imported, ctx);
    setTimeout(()=>{if(binding?.pi===pi&&binding.context===ctx)this.signalMainIdle(sessionId);},0).unref();return binding; }
  async endMainSession(pi: ExtensionAPI, sessionId: string): Promise<void> {
    const binding = this.#mains.get(sessionId); if (binding?.pi !== pi) return;
    binding.scheduler.pause();
    this.detach(pi, sessionId);
    await binding.host.endMainSession();
  }
  detach(pi: ExtensionAPI, sessionId: string): void { const binding = this.#mains.get(sessionId); if (binding?.pi === pi) { const error=new Error("Main append authority detached before a safe model boundary");for(const waiter of binding.idleWaiters)waiter.reject(error);binding.idleWaiters.clear();binding.pi = undefined; binding.context=undefined; binding.append = undefined; binding.host.mainMailboxReadContext = binding.store.mainMailboxReadContext = undefined; } }
  executor(sessionId: string): CollaborationExecutorV1 { const binding = this.#mains.get(sessionId); if (!binding) return async ({ tool }) => ({ details: { version: 1, tool, outcome: "rejected", host_revision: 0, error: { code: "unavailable", message: "Subagent Main binding is unavailable." } } }); const execute=createMainCollaborationExecutorV1({ host: binding.host, preparation: binding.preparation, runtime: binding.runtime, mainSessionId: sessionId, bindingGeneration: binding.bindingGeneration, agentDirectory: this.agentDirectory });return execute; }
  binding(sessionId: string): ProcessMainBindingV1 | undefined { return this.#mains.get(sessionId); }
  async health(): Promise<Readonly<Record<string, unknown>>> { return { backend: "sdk", protocol: 2, scheduler: this.coordinatorClaim.coordinator.snapshot(), mains: [...this.#mains.values()].map(binding => ({ mainSessionId: binding.mainSessionId, settings: binding.runtime.settingsSources() })) }; }
  signalMainIdle(sessionId: string): void {
    const binding = this.#mains.get(sessionId); if (!binding?.context?.isIdle()) return;
    for (const waiter of binding.idleWaiters) waiter.resolve(); binding.idleWaiters.clear();
    const active = this.#reconciling.get(sessionId);
    if (active) { active.requested = true; return; }
    const pass = { requested: false }; this.#reconciling.set(sessionId, pass);
    queueMicrotask(() => { void (async () => {
      // A native/source fact arriving during a bounded pass owns one more pass.
      // No timer and no reschedule merely because an obligation is still open.
      do {
        pass.requested = false;
        await this.settleMainTurn(binding); await this.reconcileMainDelivery(binding); await this.deliverRootMailbox(binding);
      } while (pass.requested && binding.context?.isIdle());
    })().catch(error => this.report("idle-delivery", error)).finally(() => this.#reconciling.delete(sessionId)); });
  }
  signalMainRunStarted(sessionId:string):void{this.#mains.get(sessionId)?.turn.runStarted();}
  observeMainContext(sessionId:string,messages:readonly unknown[]):void{this.#mains.get(sessionId)?.turn.observeContext(messages);}
  async signalMainRunEnded(sessionId:string,failed:boolean,proof?:{pi:Pick<ExtensionAPI,"appendEntry">;ctx:Pick<ExtensionContext,"sessionManager">}):Promise<void>{const binding=this.#mains.get(sessionId);if(!binding)return;if(proof)await binding.turn.recordRunEnded({...proof,failed,state:binding.host.snapshot()});else binding.turn.runEnded(failed);}
  /** DELIVERY_PROTOCOL §7.9：在既有边界（agent_settled、投递终态、reconcile）把成功轮次处理过的 pending turn 记成 settled；按 Main 串行，失败只进 diagnostics，没有 poller。 */
  private settleMainTurn(binding:ProcessMainBindingV1):Promise<void>{const previous=this.#turnSettling.get(binding.mainSessionId)??Promise.resolve();const next=previous.then(()=>binding.turn.settle({host:binding.host,mainSessionId:binding.mainSessionId,at:new Date().toISOString(),branch:binding.append?.session.getBranch(),report:(error)=>this.report("settle-main-turn",error)})).then(()=>undefined,(error)=>this.report("settle-main-turn",error));this.#turnSettling.set(binding.mainSessionId,next);return next;}
  private waitForMainIdle(binding:ProcessMainBindingV1):Promise<void>{if(!binding.pi||!binding.context)return Promise.reject(new Error("Main append authority is detached"));if(binding.context.isIdle())return Promise.resolve();return new Promise<void>((resolve,reject)=>binding.idleWaiters.add({resolve,reject}));}
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const binding of this.#mains.values()) binding.scheduler.pause();
    for (const binding of this.#mains.values()) await binding.host.endMainSession().then(() => binding.runtime.shutdown()).catch(error => this.report("runtime-shutdown", error));
    for (const binding of this.#mains.values()) binding.delivery.dispose();
    for (const binding of this.#mains.values()) await binding.scheduler.close().catch(error => this.report("scheduler-close", error));
    for (const binding of this.#mains.values()) await binding.store.close().catch(error => this.report("store-close", error));
    this.coordinatorClaim.release(); this.#mains.clear();
  }
  private async deliverSettlement(binding: ProcessMainBindingV1, input: { outboxId?: string; recipient: { kind: "main" | "agent"; session_id: string; agent_id?: string } }): Promise<void> {
    const outboxId = input.outboxId;
    if (!outboxId || binding.mailboxImportPending) return;
    if (input.recipient.kind === "main") {
      if (mainOutboxImportHold(binding, outboxId)) return;
      if (!binding.append) return;
      await driveOutboxDeliveryV1(outboxId, async () => {
        const cards = await binding.delivery.deliverOutbox(outboxId);
        if (cards.state === "skipped") return;
        const wake = await binding.delivery.settleWake(outboxId);
        if (wake.state === "delivered") await binding.append?.transport.recheckPrefix(`outbox:${outboxId}:`);
        await this.settleMainTurn(binding);
        const state = binding.host.snapshot(), current = [state.root, ...state.agents].flatMap(partition => partition.outbox).find(item => item.outbox_id === outboxId);
        if (current && binding.append) await finishMainOutboxMail(binding, current, binding.append.transport, binding.append.session.getBranch());
      });
      this.signalMainIdle(binding.mainSessionId);
      return;
    }
    if (!input.recipient.agent_id) throw new Error("Agent completion recipient is incomplete");
    await binding.runtime.flushAgent(input.recipient.agent_id as never);
  }
  /** DELIVERY_PROTOCOL §4.2：只有前台 exact-session binding 注入 root mailbox，非前台一律保持 pending。 */
  private async deliverRootMailbox(binding: ProcessMainBindingV1): Promise<void> {
    if (this.#closed || binding.mailboxImportPending || !binding.append || binding.mainSessionId !== this.#foregroundSessionId) return;
    if (this.#rootMailboxPass) { await this.#rootMailboxPass; return; }
    this.#rootMailboxPass = (async () => {
      for (let delivered = 0; delivered < 32; delivered++) {
        const message = binding.host.nextPendingRootMailboxV1();
        if (!message || !binding.append || binding.mainSessionId !== this.#foregroundSessionId) return;
        const proof = await binding.append.appendMailbox({ ...message, running: binding.context?.isIdle() !== true });
        if (proof.state !== "injected") return;
        const committed = await binding.host.commitRootMailboxInjectionV1({ messageId: message.messageId, entryId: proof.entryId, at: new Date().toISOString() });
        if (!committed.ok) { this.report("inject-root-mailbox", new Error(committed.error.message)); return; }
      }
    })().finally(() => { this.#rootMailboxPass = undefined; });
    await this.#rootMailboxPass;
  }

  /** 逐条 Outbox 隔离：一条的证据冲突进 diagnostics ring，不阻断同一轮里其它 Outbox 的投递。 */
  private async reconcileMainDelivery(binding: ProcessMainBindingV1): Promise<void> { if (binding.mailboxImportPending || !binding.append) return; const progress = await reconcileMainDeliveryV1({ host: { snapshot: () => mainImportDeliverySnapshot(binding) }, delivery: binding.delivery, mainSessionId: binding.mainSessionId, report: ({ operation, error }) => this.report(operation, error) }); for (const outboxId of progress.delivered) await binding.append?.transport.recheckPrefix(`outbox:${outboxId}:`); await this.settleMainTurn(binding); await this.reconcileMainMail(binding); }
  /** Source driver owns fallback planning; checkCurrent remains a read-only guard. */
  private async reconcileMainMail(binding: ProcessMainBindingV1): Promise<void> {
    if (!binding.append) return;
    const state = binding.host.snapshot(), retirement = await readMainMailboxRetirement(binding.host.mainMailboxReadContext);
    for (const outbox of [state.root, ...state.agents].flatMap(partition => partition.outbox)) {
      if (outbox.recipient.kind !== "main" || outbox.recipient.session_id !== binding.mainSessionId || outbox.state !== "handled" && outbox.turn_settlement?.state !== "settled" && mainOutboxImportHold(binding, outbox.outbox_id)) continue;
      const append: MainSessionAppendPortV1 | undefined = binding.append; const generation = binding.bindingGeneration;
      try {
        if (append && (outbox.state === "handled" || outbox.turn_settlement?.state === "settled") && retirement.outbox(state, outbox).kind === "retired") continue;
        await driveOutboxDeliveryV1(outbox.outbox_id, async () => {
        if (!append || binding.append !== append || binding.bindingGeneration !== generation) return;
        if (outbox.state === "handled" || outbox.turn_settlement?.state === "settled") {
          await finishMainOutboxMail(binding, outbox, append.transport, append.session.getBranch(), retirement); return;
        }
        if (outbox.state !== "delivered" || outbox.settlement_kind !== "goal-claimed" || binding.turn.hasActiveRun()
          || binding.turn.hasCardOpportunity({ state: binding.host.snapshot(), mainSessionId: binding.mainSessionId,
            branch: append.session.getBranch(), completionIds: outbox.completion_ids })) return;
        const receipt = [state.root, ...state.agents].flatMap(partition => partition.wake_receipts).find(item => item.outbox_id === outbox.outbox_id && item.wake_epoch === outbox.wake_epoch);
        if (!receipt || queryGoalContinuationObligationV1({ sessionId: binding.mainSessionId, continuationId: receipt.continuation_identity }) !== "none") return;
        if (!append.transport.hasAccepted(`outbox:${outbox.outbox_id}:${outbox.wake_epoch}:continuation`)) await append.acceptContinuation({ outboxId: outbox.outbox_id, wakeEpoch: outbox.wake_epoch,
          content: `Subagent results ${outbox.completion_ids.join(", ")} are ready. Continue from the delivered completion cards.`,
          details: { version: 1, outbox_id: outbox.outbox_id, wake_epoch: outbox.wake_epoch, completion_ids: outbox.completion_ids } });
      }); } catch (error) {
        if (binding.append === append && binding.bindingGeneration === generation) this.report(`reconcile-main-mail:${outbox.outbox_id}`, error);
      }
    }
  }
  private finishMailboxImport(binding: ProcessMainBindingV1, imported: readonly import("../mailbox/import-main.js").SubagentImportItem[], ctx: ExtensionContext): void {
    binding.mailboxImportHolds = new Map(imported.filter(item => item.state === "visible-unknown")
      .map(item => [item.key, item.reason ?? "legacy source proof is unknown"]));
    binding.mailboxImportPending = false;
    for (const [key, reason] of binding.mailboxImportHolds) this.report("mailbox-import-hold", new Error(`${key}: ${reason}`));
    if (binding.mailboxImportHolds.size) ctx.ui.notify(`Subagents mailbox import holds ${binding.mailboxImportHolds.size} legacy record(s); unrelated delivery remains active. Inspect subagent-mailbox-import-v1 for keys and reasons.`, "warning");
  }
  diagnostics():readonly Readonly<{at:string;operation:string;message:string}>[]{return Object.freeze(this.#diagnostics.map(item=>Object.freeze({...item})));}
  private report(operation:string,error:unknown):void{if(error instanceof DeliveryPending)return;const message=(error instanceof Error?error.message:String(error)).replace(/[\r\n\u0000-\u001f\u007f-\u009f]+/gu," ").slice(0,1024);this.#diagnostics.push({at:new Date().toISOString(),operation,message});if(this.#diagnostics.length>128)this.#diagnostics.splice(0,this.#diagnostics.length-128);}
}

export { getProcessServiceCellV1 } from "./service-cell.js";
