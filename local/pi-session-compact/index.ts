import { PROVIDER_ACTIVITY_CHANNEL } from "pi-runtime-contracts/provider-activity-v1";
import { CompactionDeadline, TOTAL_DEADLINE_REASON, type DeadlineSnapshot } from "./src/deadline.ts";
import { withRequestRetries, FailureBackoff, type FailureRecord } from "./src/retry.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {readFile,readdir}from"node:fs/promises";
import { compact, convertToLlm, DEFAULT_COMPACTION_SETTINGS, getAgentDir, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type CompactionResult } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream,getCurrentSystemMessage, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { readConfig, type Config, type CompactionMode } from "./src/config.ts";
import { fits, hash, reserveForWindow, reserveThreshold, contextTokens, textTokens, CONTEXT_TOKEN_METHOD } from "./src/budget.ts";
import { boundedContextTokens, measuredRecoveryBound, readMeasurementCapture, validRecoveryBound, retainedMessages, type RecoveryBound } from "./src/preflight.ts";
import { collectRecovery, includesRecovery } from "./src/collected-recovery.ts";
import { requestOnlyTokens } from "./src/request-only.ts";
import { collectFocus } from "./src/focus.ts";
import { collectUserQuotations, renderUserQuotations, type UserQuotations } from "./src/quotations.ts";
import { generationInstruction, validateOutput, PROMPT_VERSION, type ValidatedOutput } from "./src/output.ts";
import { generate, responseText, type Attempt, type RequestRecord } from "./src/generate.ts";
import { mainRequest, mainPrefix, rebuildMainPrefix, MainPrefixUnavailableError, canRebuildMainPrefix, routesToSmall, type Admission, type MainMemorySelection, type MainPrefixSource, type PrefixCaptureDiagnostic } from "./src/main.ts";
import { writeRun } from "./src/log.ts";
import { collectMaterials } from "./src/materials.ts";
import { collectInventory, renderInventory, type Inventory } from "./src/inventory.ts";
import { generateSmall } from "./src/small.ts";
import { installHistoryTools } from "./src/tools.ts";
import {restoredContext,recoveryText,describeOverflow,type RestoreRef, type RecoveryOptions}from"./src/recovery.ts";
import { COMPACTION_SUBCOMMANDS, WINDOW_ENTRY, compactionCompletions, keepRecentFor, minimumWindow, parseWindow, sessionWindow, windowAction, windowFirstKept, windowThreshold, type WindowGuard } from "./src/window.ts";
import { fallbackDescription, parseNow, selectMode, type ModeSelection } from "./src/mode.ts";
import { describeCompaction, type RunLog } from "./src/show.ts";
import { STATUS_LINE_ROW_CHANNEL, compactionStatus, compactionStatusLine, compactionStatusPayload } from "./src/status.ts";
import { describeReserve, parseReserve, reserveReport } from "./src/reserve.ts";
import { filterMailboxMessages } from "pi-session-inject/mailbox-v1/light";

export interface SlotOutput {
  requestedMode: string; effectiveMode: string; status: string; attempts: Attempt[];
  runLogPath?: string; requestPlan?: import("./src/request-plan.ts").RequestPlan; requestedModel?: string; effectiveModel?: string; rawOutput?: string; validated?: ValidatedOutput;
  fallbackReason?: string; prefix?: MainPrefixSource; prefixCapture?: PrefixCaptureDiagnostic; modeReason?: string; error?: string; admission?: Admission; mainMemory?: MainMemorySelection;
}
interface Run {
  version: number; operationId: string; sessionId: string; status: string; triggerReason: string; startedAt: string;
  inputFingerprint: Record<string, unknown>; threshold: Record<string, unknown>; compactInstructions: ReturnType<typeof collectFocus>;
  modeSelection: ModeSelection; shadow: Config["shadow"]; outputs: Partial<Record<"main" | "small", SlotOutput>>;
  adopted: { slot: string; effectiveMode: string; compactionEntryId?: string } | null;
  degraded: { occurred: boolean; reason?: string; nativeOutcome?: string; nativeSummary?: string; nativeFocusScope?: string; attempts: Attempt[]; admission?: Record<string, unknown>; restoredContextGate?: Record<string, unknown> };
  contextSizes: { before: Record<string, unknown>; requests: RequestRecord[]; after: Record<string, unknown> };
  totalDeadline?: DeadlineSnapshot; customFailure?: { key: string; state?: FailureRecord; outcome: "success" | "failure" | "cancelled" | "backoff" };
  warnings: string[]; timings: Record<string, number | null>; totalElapsedMs?: number; userMessages?:unknown;totalUsage?:unknown;
}
export default function sessionCompact(pi: ExtensionAPI): void {
  installHistoryTools(pi);
  const failureBackoff = new FailureBackoff();
  const activeControllers=new Set<AbortController>();
  let backgroundShadow: AbortController | undefined;
  const shadowSettles = new Set<Promise<void>>();
  // A cancelled shadow writes its final record quickly; bound the wait in case a provider ignores abort.
  const settleShadows = () => Promise.race([Promise.all(shadowSettles), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
  let epoch = 0;
  const pending = new Map<string, { run: Run; path: string; started: number; result?: CompactionResult; deadline?: CompactionDeadline }>();
  // Admission outlives first-request accounting and tree fences. Select only the
  // current branch's exact compaction entry; session start/shutdown reset the cache.
  const recoveryProofs = new Map<string, { sessionId: string; operationId: string; bound: RecoveryBound }>();
  const rememberProof = (entry: CompactionEntry, run: Run) => {
    const bound = run.contextSizes.before.recoveryBound;
    if ((entry.details as { operationId?: string })?.operationId === run.operationId && validRecoveryBound(bound))
      recoveryProofs.set(entry.id, { sessionId: run.sessionId, operationId: run.operationId, bound });
  };
  let lastBusiness: { sessionId: string; leaf: string | null; usage: AssistantMessage["usage"]; requestId: string } | undefined;
  let nextBusiness: { operationId: string; leaf: string | null; requestId: string; additionalContext: boolean } | undefined;
  let writeQueue=Promise.resolve();
  // Session-window trigger: the compaction this plugin started, and the anti-loop guard after it.
  let manualRun: { sessionId: string; mode?: CompactionMode; consumed: boolean } | undefined;
  let windowRun: { sessionId: string } | undefined;
  let windowGuard: (WindowGuard & { sessionId: string }) | undefined;
  const warn = (ctx: ExtensionContext, message: string) => ctx.ui.notify(`pi-session-compact：${message}`, "warning");
  const persist = async (item: { run: Run; path: string; deadline?: CompactionDeadline }, ctx: ExtensionContext) => {
    const start = performance.now();
    if (item.deadline) item.run.totalDeadline = item.deadline.snapshot();
    const attempts=[...Object.values(item.run.outputs).flatMap(o=>o.attempts),...item.run.degraded.attempts];
    item.run.totalUsage={rawAttempts:attempts.filter(a=>a.usage).map(a=>({phase:a.phase,model:a.model,usage:a.usage})),requestsInOperation:attempts.filter(a=>a.sent).length,semantics:"Raw provider input/cache fields; no double-counted context total."};
    try {const write=writeQueue.then(()=>writeRun(item.path, item.run));writeQueue=write.catch(()=>{});await write;item.run.timings.logWriteMs = (item.run.timings.logWriteMs ?? 0) + performance.now() - start;return true; }
    catch (error) { warn(ctx, `运行日志写入失败：${String(error)}。`); return false; }
  };
  const fence=()=>{epoch++;for(const c of activeControllers)c.abort(new Error("session-boundary-changed"));activeControllers.clear();pending.clear();nextBusiness=undefined;windowRun=undefined;windowGuard=undefined;manualRun=undefined;};
  // CC Style statusline segment (CP/CT), user-only. It is recomputed from the active branch only at
  // session/branch boundaries, after a compaction commits and on window or model changes; never while one runs.
  let statusCtx: ExtensionContext | undefined;
  const publishStatus = (ctx: ExtensionContext) => {
    statusCtx = ctx;
    // Display only: a failure here must not skip the reconciliation in the same handler.
    try {
      const line = compactionStatusLine(compactionStatus(ctx.sessionManager.getBranch(), ctx.model?.contextWindow), (tone, text) => ctx.ui.theme.fg(tone, text));
      pi.events.emit(STATUS_LINE_ROW_CHANNEL, compactionStatusPayload(line, () => {
        if (statusCtx !== ctx) return false;
        void showCommand(ctx).catch((error) => warn(ctx, `无法打开压缩视图：${String(error)}`));
        return true;
      }));
    } catch {}
  };
  const withdrawStatus = () => { statusCtx = undefined; try { pi.events.emit(STATUS_LINE_ROW_CHANNEL, compactionStatusPayload(undefined)); } catch {} };
  pi.on("session_start", async (_e,ctx) => {
    fence();recoveryProofs.clear();lastBusiness=undefined;publishStatus(ctx);
    await settleShadows(); // a same-session restart must not read a run before its cancelled shadow is written
    const sessionId=ctx.sessionManager.getSessionId(),runDir=join(getAgentDir(),"pi-session-compact/runs",sessionId);
    const savedRuns: Run[] = [];
    for(const name of await readdir(runDir).catch(()=>[])){
      if(!/^[a-f0-9-]+\.json$/.test(name))continue;
      const path=join(runDir,name);
      try{const run=JSON.parse(await readFile(path,"utf8"))as Run;
        if (run.sessionId === sessionId) savedRuns.push(run);
        const committed=ctx.sessionManager.getEntries().find(e=>e.type==="compaction"&&(e.details as{operationId?:string})?.operationId===run.operationId);
        if (run.sessionId === sessionId && committed?.type === "compaction") rememberProof(committed, run);
        const unfinished=!committed&&["generating","generated","degraded"].includes(run.status);
        const open=[...Object.values(run.outputs).flatMap(o=>o.attempts),...run.degraded.attempts].filter(a=>a.status==="started");
        const stuck=unfinished?[]:Object.values(run.outputs).filter(o=>o.status==="generating");
        if(run.sessionId!==sessionId||!unfinished&&!open.length&&!stuck.length)continue;
        if(unfinished)run.status="interrupted";
        for(const attempt of open){attempt.status="interrupted";attempt.usageKnown=false;attempt.error="Process ended before response settlement; usage unknown.";}
        for(const output of stuck){output.status="cancelled";output.error="shadow-cancelled: the process ended or the session restarted before the shadow settled; not replayed";}
        run.warnings.push(unfinished?"Interrupted operation reconciled on resume; no request or compaction replayed.":"Unsettled background shadow marked cancelled on resume; not replayed.");await persist({run,path},ctx);
      }catch(error){warn(ctx,`中断日志检查失败：${String(error)}`);}
    }
    for (const run of savedRuns.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (run.customFailure?.outcome === "success") failureBackoff.settle(run.customFailure.key, "success");
      else if (run.customFailure?.state) failureBackoff.restore(run.customFailure.key, run.customFailure.state);
    }
    const entry=ctx.sessionManager.getBranch().findLast(e=>e.type==="compaction");const d=entry?.details as {operationId?:string;generator?:string}|undefined;
    if(!entry||!d?.operationId||!["pi-native","pi-session-compact"].includes(d.generator??""))return;
    const path=join(getAgentDir(),"pi-session-compact/runs",ctx.sessionManager.getSessionId(),`${d.operationId}.json`);
    try{const run=JSON.parse(await readFile(path,"utf8"))as Run;if(run.operationId!==d.operationId||run.sessionId!==ctx.sessionManager.getSessionId())throw new Error("operation log identity mismatch");
      if(run.adopted){run.adopted.compactionEntryId=entry.id;if(run.degraded.occurred)run.degraded.nativeOutcome="committed";else run.status="committed";}
      pending.set(d.operationId,{run,path,started:performance.now()});await persist({run,path},ctx);
    }catch(error){warn(ctx,`已压缩会话的运行日志无法恢复：${String(error)}；保留原会话，不重新生成或提交。`);}
  });
  pi.on("session_tree", (_e, ctx) => { fence(); publishStatus(ctx); });
  pi.on("session_shutdown", async () => { fence(); recoveryProofs.clear(); withdrawStatus(); await settleShadows(); });
  pi.on("model_select", (_e, ctx) => { if (statusCtx) publishStatus(ctx); });
  pi.on("before_agent_start",(_event,ctx)=>{
    const branch=ctx.sessionManager.getBranch(),entry=branch.findLast(e=>e.type==="compaction");
    const details=entry?.details as {operationId?:string;restoreSkills?:RestoreRef[];recoveryText?:string}|undefined;
    if(!details?.operationId)return;
    if(!includesRecovery(details,"pi-session-compact","pi-session-compact:recovery-v1")&&!branch.some(e=>e.type==="custom_message"&&e.customType==="pi-session-compact:recovery-v1"&&(e.details as {operationId?:string})?.operationId===details.operationId))
      pi.sendMessage({customType:"pi-session-compact:recovery-v1",content:details.recoveryText??recoveryText(),display:false,details:{version:1,operationId:details.operationId}},{deliverAs:"nextTurn",triggerTurn:false});
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const started = performance.now();
    // A new compaction means the session moved on; an unfinished shadow of the previous one stops here.
    backgroundShadow?.abort(new Error("next-compaction"));
    // compact() can append an aborted assistant before this hook; session/tree fences scope the override.
    const manual = event.reason === "manual" && manualRun && !manualRun.consumed && manualRun.sessionId === ctx.sessionManager.getSessionId() ? manualRun : undefined;
    if (manual) manual.consumed = true; // Capture once, even when validation or generation cancels.
    if (!ctx.model) return { cancel: true };
    const selectionTime = Date.now();
    const frozenEpoch = epoch;
    const sessionId = ctx.sessionManager.getSessionId();
    const triggerReason = windowRun?.sessionId === sessionId ? "session-window" : event.reason;
    const branch = structuredClone(event.branchEntries);
    const leaf = ctx.sessionManager.getLeafId();
    const operationId = randomUUID();
    const focus = collectFocus(ctx.cwd, getAgentDir(), event.customInstructions);

    const materials = await collectMaterials(pi, ctx, getAgentDir(), branch);
    const stillFrozen = () => !event.signal.aborted && epoch === frozenEpoch && ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() === leaf;
    if (!stillFrozen()) return { cancel: true };
    const projection = ctx.sessionManager.buildSessionProjection();
    const native = convertToLlm(projection.messages);
    const systemAndTools = contextTokens(native.filter(m => m.role === "system"));
    // A session window replaces the model window for every plugin budget; Pi's native threshold keeps the real one.
    const configuredWindow = sessionWindow(branch);
    const effectiveWindow = configuredWindow ? Math.min(configuredWindow, ctx.model.contextWindow) : undefined;
    const window = effectiveWindow ?? ctx.model.contextWindow;
    const keepRecent = effectiveWindow ? keepRecentFor(effectiveWindow) : undefined;
    const firstKeptEntryId = keepRecent !== undefined && keepRecent !== event.preparation.settings.keepRecentTokens ? windowFirstKept(branch, keepRecent) ?? event.preparation.firstKeptEntryId : event.preparation.firstKeptEntryId;
    const keptAt = branch.findIndex((e) => e.id === firstKeptEntryId);
    let inventory: Inventory;
    const retainedRecent = contextTokens(convertToLlm(projection.entries.filter((e) => branch.findIndex((b) => b.id === e.sourceEntry.id) >= keptAt).flatMap((e) => e.messages)).filter((m) => m.role !== "system"));
    const totalBefore = contextTokens(native);
    const reserve = event.preparation.settings.reserveTokens;
    const warnings = [...focus.warnings];
    const nativeThreshold = reserveThreshold(ctx.model.contextWindow, reserve);
    const triggerThreshold = triggerReason === "session-window" && effectiveWindow
      ? reserveThreshold(effectiveWindow, effectiveWindow - windowThreshold(effectiveWindow))
      : triggerReason === "threshold" ? nativeThreshold : undefined;
    if (!effectiveWindow) {
      // Accept the static >90% reserve and the one-token adjustment for >=90%; do not infer a dynamic policy.
      const message = !nativeThreshold ? `无法核验原生压缩阈值：模型窗口 ${window}，reserveTokens=${reserve}；本次继续压缩。`
        : reserve !== reserveForWindow(window) && reserve !== Math.floor(window / 10) + 1
          ? `当前模型窗口 ${window}、reserveTokens=${reserve}，Pi 原生条件为 tokens > ${nativeThreshold.boundaryTokens}（最早 ${nativeThreshold.triggerTokens}，约 ${(nativeThreshold.ratio * 100).toFixed(4)}%），不是 90%；本次继续压缩，请检查压缩策略或配置。` : undefined;
      if (message) { warnings.push(message); warn(ctx, message); }
    }
    let config: Config;
    try { config = await readConfig(getAgentDir()); }
    catch (error) { warn(ctx, `配置无效，取消压缩：${String(error)}`); return { cancel: true }; }
    const modeSelection = selectMode(config, branch, manual?.mode, selectionTime);
    let provenPrefix: Message[] | undefined, prefixFailure: string | undefined, prefixCapture: PrefixCaptureDiagnostic | undefined, prefixSource: MainPrefixSource | undefined;
    try { provenPrefix = mainPrefix(pi, ctx, branch); prefixSource = { source: "capture", reason: "confirmed-effective-request" }; } catch (error) {
      prefixFailure = String(error);
      if (error instanceof MainPrefixUnavailableError) {
        prefixCapture = error.diagnostic;
        if (canRebuildMainPrefix(error) && (modeSelection.selectedMode === "main" || config.shadow.enabled)) {
          try {
            provenPrefix = await rebuildMainPrefix(pi, ctx, branch);
            prefixSource = { source: "rebuilt", reason: error.message };
            prefixFailure = undefined;
          } catch (rebuildError) { prefixFailure = String(rebuildError); }
        }
      }
    }
    for (const message of config.deprecatedSettings ?? []) { warnings.push(message); warn(ctx, message); }
    const selectedSkills: RestoreRef[] = materials.skills.map(({ contents, ...ref }) => ({ ...ref, reason: "Restore the latest actual loaded version." }));
    const systemMessage = getCurrentSystemMessage(provenPrefix ?? native);
    const reported = lastBusiness?.sessionId === sessionId ? lastBusiness : undefined;
    const bound = measuredRecoveryBound(branch, ctx.model, reported, readMeasurementCapture(sessionId, branch, ctx.model));
    const recoveryOptions: RecoveryOptions = { systemMessage, additionalTokens: requestOnlyTokens(branch, provenPrefix ?? [], firstKeptEntryId), reserveTokens: reserve, bound };
    let recovery: ReturnType<typeof collectRecovery>;
    let quotations: UserQuotations;
    let quotationText: string;
    let inventoryText: string;
    try {
      recovery = collectRecovery(pi, ctx, operationId, selectedSkills, branch);
      recoveryOptions.recoveryAppendix = recovery.appendix;
      quotations = collectUserQuotations(branch, firstKeptEntryId);
      quotationText = renderUserQuotations(quotations);
      inventory = collectInventory(branch, firstKeptEntryId, ctx.cwd);
      inventoryText = renderInventory(inventory);
      const fixed = restoredContext(branch, { summary: quotationText + inventoryText + recovery.appendix, firstKeptEntryId, tokensBefore: event.preparation.tokensBefore }, window, { ...recoveryOptions, handoff: "", quotations: quotationText, inventory: inventoryText });
      if (!fixed.fits) { warn(ctx, describeOverflow(fixed.estimated, window)); ctx.abort(); return { cancel: true }; }
    } catch (error) { warn(ctx, `无法完整保留用户原话，取消压缩：${String(error)}`); ctx.abort(); return { cancel: true }; }
    if (!stillFrozen()) return { cancel: true };
    const previousCompactionId = branch.findLast(e => e.type === "compaction")?.id;
    const run: Run = {
      version: 1, operationId, sessionId, status: "generating", triggerReason, startedAt: new Date().toISOString(),
      inputFingerprint: { branchLeaf: leaf, previousCompactionId, firstKeptEntryId, frozenBranchHash: hash(branch), modelToolsHash: hash({ model: ctx.model, tools: pi.getAllTools(), active: pi.getActiveTools() }), focusHash: focus.mergedHash, memoryFiles: materials.memory.map(({path,hash})=>({path,hash})), skillRefs: materials.skills.map(({contents,...ref})=>ref) },
      threshold: { contextWindow: ctx.model.contextWindow, model: `${ctx.model.provider}/${ctx.model.id}`, windowSource: "selected-model", ...(effectiveWindow ? { effectiveWindow, keepRecentTokens: keepRecent } : {}), reserveTokens: reserve, native: nativeThreshold, tokensBefore: event.preparation.tokensBefore, eventReason: event.reason, ...(triggerThreshold ? { ...triggerThreshold, source: triggerReason } : {}) }, compactInstructions: focus,
      modeSelection, shadow: { ...config.shadow, adopt: modeSelection.selectedMode }, outputs: {}, adopted: null, degraded: { occurred: false, attempts: [] },
      contextSizes: { before: { estimated: { systemAndTools, toBeCompacted: Math.max(0, totalBefore - systemAndTools - retainedRecent), retainedRecent, total: totalBefore, method: CONTEXT_TOKEN_METHOD }, recoveryBound: bound, providerReported: lastBusiness?.sessionId === sessionId ? { ...lastBusiness, stale: lastBusiness.leaf !== leaf } : null }, requests: [], after: { estimated: null, providerReported: null } },
      warnings, timings: { logWriteMs: 0, hostCommitMs: null, recoveryMs: null, pauseToNextBusinessRequestMs: null },
      userMessages: { version: 1, count: quotations.items.length, tokens: textTokens(quotationText), firstKeptEntryId },
    };
    const mainEffort = ctx.thinkingLevel ?? pi.getThinkingLevel();
    const instruction = generationInstruction();
    const preparedMain = provenPrefix && (modeSelection.selectedMode === "main" || config.shadow.enabled) ? {
      prefix: provenPrefix,
      // A rebuilt prompt/loadout is not the measured old request. Admit the full estimate.
      request: mainRequest(branch, provenPrefix, config, window, { instruction, materials, focus: focus.mergedText }, prefixSource?.source === "capture" ? ctx.model : undefined),
    } : undefined;
    // Canonical material excludes transport accounting and empty aborted messages in either prefix.
    const inputMaterial = (messages: Message[]) => messages.filter(m => m.role !== "assistant" || m.content.length > 0).map(message => {
      const { timestamp: _timestamp, usage: _usage, stopReason: _stopReason, errorMessage: _errorMessage, ...body } = message as unknown as Record<string, unknown>;
      return body;
    });
    const usesMain = modeSelection.selectedMode === "main" && preparedMain?.request.admission.passed;
    const requestIdentity = {
      selectedMode: modeSelection.selectedMode,
      mainEffort: modeSelection.selectedMode === "main" ? mainEffort : undefined,
      effectiveEffort: usesMain ? mainEffort : config.smallModel?.effort ?? mainEffort,
      shape: usesMain ? "main-prefix" : "small-frozen-sources",
      ...(modeSelection.selectedMode === "main" && prefixSource ? { prefixSource: prefixSource.source } : {}),
      prefixHash: modeSelection.selectedMode === "main" && provenPrefix ? hash(inputMaterial(provenPrefix)) : null,
    };
    run.inputFingerprint.requestIdentity = requestIdentity;
    const failureKey = hash({ sessionId, requestIdentity, projectionHash: hash(inputMaterial(native)), goal: materials.goal, quotations: hash(quotations), firstKeptEntryId, focus: focus.mergedHash, memory: run.inputFingerprint.memoryFiles, skills: run.inputFingerprint.skillRefs, model: ctx.model, tools: run.inputFingerprint.modelToolsHash, config, promptVersion: PROMPT_VERSION });
    const blocked = failureBackoff.blocked(failureKey);
    const item: { run: Run; path: string; started: number; result?: CompactionResult; deadline?: CompactionDeadline } = { run, path: join(getAgentDir(), "pi-session-compact/runs", sessionId, `${operationId}.json`), started };
    pending.set(operationId, item);
    const controller = new AbortController();
    activeControllers.add(controller);
    const abort = () => controller.abort(event.signal.reason);
    event.signal.addEventListener("abort", abort, { once: true });
    if (event.signal.aborted) abort();
    const deadline = new CompactionDeadline({ sessionId, minutes: config.totalTimeoutMinutes, queuePauseCapMinutes: config.queuePauseCapMinutes, startedAt: started, subscribe: handle => pi.events.on(PROVIDER_ACTIVITY_CHANNEL, handle) });
    item.deadline = deadline;
    const finishOnBoundary = () => deadline.finish();
    controller.signal.addEventListener("abort", finishOnBoundary, { once: true });
    if (controller.signal.aborted) deadline.finish();
    const customSignal = AbortSignal.any([controller.signal, deadline.signal]);
    let adoptDone = false, shadowPending = false;
    const completeDeadline = () => { if (adoptDone && !shadowPending) { deadline.finish(); controller.signal.removeEventListener("abort", finishOnBoundary); } };
    const applicable = () => !controller.signal.aborted && epoch === frozenEpoch && ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() === leaf;
    const adopt = modeSelection.selectedMode;
    const shadowSlot: "main" | "small" | undefined = config.shadow.enabled ? (adopt === "main" ? "small" : "main") : undefined;
    let shadow: AbortController | undefined;
    const generateSlot = async (slot: "main" | "small", signal: AbortSignal, ctx: ExtensionContext) => {
      const output: SlotOutput = { requestedMode: slot, effectiveMode: slot, status: "generating", attempts: [], runLogPath: item.path,
        ...(slot === "main" ? { prefix: prefixSource, prefixCapture } : {}) };
      run.outputs[slot] = output;
      const requestRetry = { enabled: slot === adopt, pi: pi.getSettings().retry };
      const small = async () => {
        output.effectiveMode = "small";
        if (slot === "main" && output.fallbackReason) output.modeReason = fallbackDescription(output.fallbackReason);
        const selectedModel = config.smallModel ?? ctx.model!;
        output.requestedModel ??= `${selectedModel.provider}/${selectedModel.id}`;
        output.effectiveModel = `${selectedModel.provider}/${selectedModel.id}`;
        if (!config.smallModel) {
          output.modeReason = `${output.modeReason ? `${output.modeReason}；` : ""}未配置 smallModel，使用当前模型的完整 source 路径；失败时交给 native。`;
          warn(ctx, output.modeReason);
        }
        const result = await generateSmall(ctx, config, branch, focus, materials, signal, output.attempts, run.contextSizes.requests, slot, output, () => persist(item, ctx), requestRetry, deadline);
        output.effectiveModel = result.model; output.rawOutput = result.rawOutput; output.validated = result.validated;
      };
      try {
        if (slot === "small") { await small(); output.status = "generated"; return; }
        output.requestedModel = output.effectiveModel = `${ctx.model!.provider}/${ctx.model!.id}`;
        if (!preparedMain) { output.fallbackReason = prefixFailure ?? "effective-prefix-unavailable"; output.prefixCapture = prefixCapture; await small(); output.status = "generated"; return; }
        const { prefix, request: { append, admission, memory } } = preparedMain;
        output.mainMemory = memory;
        output.admission = admission;
        if (!admission.passed) { output.fallbackReason = "main-budget-overflow"; await small(); output.status = "generated"; return; }
        const model = ctx.model!, effort = mainEffort;
        const context = { messages: [...prefix, { role: "user" as const, content: append, timestamp: Date.now() }] };
        const validated = await withRequestRetries(config, signal, output.attempts, () => persist(item, ctx), requestRetry, async retry => {
          const response = await generate(ctx, config, model, context, effort, signal, output.attempts, run.contextSizes.requests, slot, "main", { prefix: contextTokens(prefix), append: { instruction: textTokens(instruction), compactInstructions: focus.estimatedTokens }, deadlineInputTokens: (admission.observedUncachedTokens ?? admission.estimatedPrefix) + admission.estimatedTrailing + admission.estimatedAppend, contextSource: admission.contextSource, providerUsageTokens: admission.providerUsageTokens },()=>persist(item,ctx),"caller",retry,deadline);
          output.rawOutput = output.attempts.at(-1)!.rawOutput ?? responseText(response);
          const validated = validateOutput(output.rawOutput);
          deadline.throwIfExpired(); signal.throwIfAborted();
          return validated;
        });
        output.validated = validated;
        output.status = "generated";
      } catch (error) {
        if (slot === "main" && output.effectiveMode === "main" && routesToSmall(error) && !signal.aborted) {
          output.fallbackReason = String(error);
          try { await small(); output.status = "generated"; return; } catch (fallback) { error = fallback; }
        }
        output.status = "failed"; output.error = String(error);
      }
    };
    // The shadow never delays adoption. It settles in the background into this run log only and
    // never touches the session. A session boundary, the next compaction or an operation that
    // does not commit cancels it; it is never replayed.
    const startShadow = (slot: "main" | "small") => {
      const own = shadow = backgroundShadow = new AbortController();
      shadowPending = true;
      const stopDeadline = () => own.abort(deadline.signal.reason);
      deadline.signal.addEventListener("abort", stopDeadline, { once: true });
      if (deadline.signal.aborted) stopDeadline();
      const stop = () => own.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", stop, { once: true });
      if (controller.signal.aborted) stop();
      activeControllers.add(own);
      // Silent: the same context with a UI that drops notices; results and failures go only to the run log.
      const quiet = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(ctx), ui: { value: { notify() {} } } }) as ExtensionContext;
      // Only requests still open when the shadow is cancelled lose their usage; settled ones keep it.
      let inFlight: Attempt[] = [];
      own.signal.addEventListener("abort", () => { if (adoptDone) deadline.finish(); inFlight = run.outputs[slot]?.attempts.filter((a) => a.status === "started") ?? []; }, { once: true });
      const settled: Promise<void> = generateSlot(slot, own.signal, quiet).then(async () => {
        shadowPending = false; completeDeadline();
        deadline.signal.removeEventListener("abort", stopDeadline);
        controller.signal.removeEventListener("abort", stop); activeControllers.delete(own);
        if (backgroundShadow === own) backgroundShadow = undefined;
        const output = run.outputs[slot]!;
        if (own.signal.aborted && output.status !== "generated") {
          output.status = "cancelled"; output.error = `shadow-cancelled: ${String(own.signal.reason)}`;
          for (const attempt of inFlight) { attempt.status = "interrupted"; attempt.usageKnown = false; delete attempt.usage; }
        }
        run.timings.shadowSettledMs = performance.now() - started;
        await persist(item, quiet);
      }).catch(() => {}).finally(() => shadowSettles.delete(settled));
      shadowSettles.add(settled);
    };
    try {
      if (blocked) {
        run.customFailure = { key: failureKey, state: blocked, outcome: "backoff" };
        run.outputs[adopt] = { requestedMode: adopt, effectiveMode: adopt, status: "not_started", attempts: [], error: `same-input-failure-backoff: ${blocked.failures} failures; retry after ${new Date(blocked.retryAfter).toISOString()}` };
      } else if(await persist(item,ctx)){const adopted=generateSlot(adopt,customSignal,ctx);if(shadowSlot)startShadow(shadowSlot);await adopted;}
      else for(const slot of shadowSlot?[adopt,shadowSlot]:[adopt])run.outputs[slot]={requestedMode:slot,effectiveMode:slot,status:"not_started",attempts:[],error:"generating-log-unavailable"};
      adoptDone = true; completeDeadline();
      if (!applicable()) { run.status = "cancelled"; await persist(item, ctx); return { cancel: true }; }
      const output = run.outputs[adopt];
      if (!blocked && output?.attempts.some(a => a.sent)) {
        const outcome = output.validated ? "success" : controller.signal.aborted ? "cancelled" : "failure";
        run.customFailure = { key: failureKey, outcome, state: failureBackoff.settle(failureKey, outcome) };
      }
      let result: CompactionResult;
      let recoveryPlan:ReturnType<typeof restoredContext>|undefined;
      const generatedLogged = await persist(item, ctx);
      let customResult:CompactionResult|undefined;
      let customInventory:Inventory|undefined;
      if(output?.validated&&generatedLogged){
        recovery = collectRecovery(pi, ctx, operationId, selectedSkills, branch);
        recoveryOptions.recoveryAppendix = recovery.appendix;
        customInventory=inventory;
        customResult={summary:output.validated.summary+quotationText+inventoryText+recovery.appendix,firstKeptEntryId,tokensBefore:event.preparation.tokensBefore,usage:output.attempts.at(-1)?.usage};
        recoveryPlan=restoredContext(branch,customResult,window,{...recoveryOptions,handoff:output.validated.summary,quotations:quotationText,inventory:inventoryText});
        if(!recoveryPlan.fits){output.error=describeOverflow(recoveryPlan.estimated,window);output.status="failed";customResult=undefined;}
      }
      if (customResult) {
        result = customResult;
        run.status = "generated"; run.adopted = { slot: adopt, effectiveMode: output!.effectiveMode };
      } else {
        run.degraded.occurred = true; run.degraded.reason = deadline.signal.aborted ? TOTAL_DEADLINE_REASON : output?.error ?? "output-log-unavailable";
        run.degraded.nativeFocusScope = event.preparation.isSplitTurn ? "history-and-turn-prefix" : "history";
        run.degraded.admission = { enforced: true, reason: "native output must also fit complete recovery context" };
        run.status = "degraded";
        warn(ctx, deadline.signal.aborted ? "自定义压缩总时限已用尽（不含排队时间），正在降级为 Pi 原生压缩。" : "自定义压缩失败，正在降级为 Pi 原生压缩。");
        const nativeStream: Parameters<typeof compact>[7] = (model, context, options) => {
          const stream = createAssistantMessageEventStream();
          void (async () => {
            try {
              // Native retains its own output policy and passes physical input admission.
              const response = await generate(ctx, config, model, { messages: context.messages }, options?.reasoning ?? ctx.thinkingLevel ?? pi.getThinkingLevel(), controller.signal, run.degraded.attempts, run.contextSizes.requests, "native", "native", { sources: { messages: contextTokens(context.messages), compactInstructionsIncluded: true } },()=>persist(item,ctx),"none", undefined, undefined, options?.maxTokens ?? null);
              stream.push({ type: "start", partial: response }); stream.push({ type: "done", reason: "stop", message: response });
            } catch (error) {
              const response: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: controller.signal.aborted ? "aborted" : "error", errorMessage: String(error), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
              stream.push({ type: "error", reason: response.stopReason as "error" | "aborted", error: response });
            }
          })();
          return stream;
        };
        // Registry owns request-time auth, baseUrl/env and provider composition. Native stream
        // delegates to that same public entry; never read private AgentSession routing fields.
        const retry = pi.getSettings().retry;
        const preparation = { ...event.preparation,
          messagesToSummarize: await filterMailboxMessages(ctx, event.preparation.messagesToSummarize),
          turnPrefixMessages: await filterMailboxMessages(ctx, event.preparation.turnPrefixMessages) };
        result = await compact(preparation, ctx.model, undefined, undefined, focus.mergedText || undefined, controller.signal, ctx.thinkingLevel ?? pi.getThinkingLevel(), nativeStream, undefined, { enabled: retry?.enabled ?? true, maxRetries: retry?.maxRetries ?? 3, baseDelayMs: retry?.baseDelayMs ?? 2000, maxAgentDelayMs: retry?.maxAgentDelayMs ?? 60000 });
        run.degraded.nativeOutcome = "generated"; run.degraded.nativeSummary = result.summary;
        quotations = collectUserQuotations(branch, result.firstKeptEntryId);
        quotationText = renderUserQuotations(quotations);
        const nativeBody = result.summary;
        recovery = collectRecovery(pi, ctx, operationId, selectedSkills, branch);
        recoveryOptions.recoveryAppendix = recovery.appendix;
        recoveryOptions.additionalTokens = requestOnlyTokens(branch, provenPrefix ?? [], result.firstKeptEntryId);
        result.summary += quotationText + recovery.appendix;
        // Native owns its existing file appendix; never append a second inventory.
        customInventory = undefined;
        recoveryPlan = restoredContext(branch,result,window,{...recoveryOptions,handoff:nativeBody,quotations:quotationText,inventory:""});
        run.degraded.restoredContextGate = { passed: recoveryPlan.fits, enforced: true, ...recoveryPlan.estimated, window };
        if (!recoveryPlan.fits) throw new Error(describeOverflow(recoveryPlan.estimated,window));
        run.adopted = { slot: "native", effectiveMode: "native" };
        warn(ctx, "自定义压缩失败，已降级为 Pi 原生压缩；摘要使用原生格式。");
      }
      if (!applicable()) { run.status = "cancelled"; await persist(item, ctx); return { cancel: true }; }
      result.details = { version: 2, operationId, generator: run.adopted!.slot === "native" ? "pi-native" : "pi-session-compact", nativeDetails: result.details, ...(run.adopted!.slot !== "native" ? customInventory : {}), userQuotations: quotations, handoff: output?.validated && run.adopted!.slot !== "native" ? output.validated.summary : run.degraded.nativeSummary, runLog: `pi-session-compact/runs/${sessionId}/${operationId}.json`, requestedMode: adopt, effectiveMode: run.adopted!.effectiveMode, restoreSkills: selectedSkills, recoveryText: recoveryText(), recovery: recovery.details };
      run.userMessages = { version: 1, count: quotations.items.length, tokens: textTokens(quotationText), firstKeptEntryId: result.firstKeptEntryId };
      run.contextSizes.after.estimated = recoveryPlan!.estimated;
      item.result = result;
      run.totalElapsedMs = performance.now() - started;
      if (!await persist(item, ctx) && run.adopted!.slot !== "native") return { cancel: true };
      if (!applicable()) { run.status = "cancelled"; await persist(item, ctx); return { cancel: true }; }
      return { compaction: result };
    } catch (error) {
      run.status = controller.signal.aborted || !applicable() ? "cancelled" : "failed";
      if(run.degraded.attempts.some(a=>a.sent))run.degraded.nativeOutcome = run.status === "cancelled" ? "cancelled" : "failed";
      run.warnings.push(String(error)); await persist(item, ctx);
      if (run.status !== "cancelled") {warn(ctx, `原生降级也失败，保留原文并停止：${String(error)}`);ctx.abort();}
      return { cancel: true };
    } finally { adoptDone = true; completeDeadline(); event.signal.removeEventListener("abort", abort);activeControllers.delete(controller);if(!item.result){pending.delete(operationId);shadow?.abort(new Error("operation-not-committed"));} }
  });
  pi.on("session_compact", async (event, ctx) => {
    // Pi 1.3 can hand the event an older entry when native summary text repeats.
    // Reconcile only the latest current-branch operation identity, never text equality.
    publishStatus(ctx);
    const committed=ctx.sessionManager.getBranch().findLast(e=>e.type==="compaction");
    const details = committed?.details as { operationId?: string;restoreSkills?:RestoreRef[];recoveryText?:string } | undefined;
    const item = details?.operationId ? pending.get(details.operationId) : undefined;
    if (!item || item.run.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (committed?.type === "compaction") rememberProof(committed, item.run);
    item.run.adopted!.compactionEntryId = committed!.id;
    if (item.run.degraded.occurred) item.run.degraded.nativeOutcome = "committed";
    else item.run.status = "committed";
    item.run.timings.hostCommitMs = performance.now() - item.started - (item.run.totalElapsedMs ?? 0);
    ctx.ui.notify(`压缩完成${item.run.degraded.occurred ? "（采用 Pi 原生兜底）" : ""}：交接正文与完整累计用户原话已保留。`, "info");
    if(!includesRecovery(details,"pi-session-compact","pi-session-compact:recovery-v1"))pi.sendMessage({customType:"pi-session-compact:recovery-v1",content:recoveryText(),display:false,details:{version:1,operationId:item.run.operationId}},{triggerTurn:false});
    await persist(item, ctx);
  });
  pi.on("context_with_system", (event, ctx) => {
    const compact=ctx.sessionManager.getBranch().findLast(e=>e.type==="compaction");
    const d=compact?.details as {operationId?:string;restoreSkills?:unknown[]}|undefined;
    const messages = convertToLlm(event.messages);
    let actualEstimate = boundedContextTokens(messages, []);
    if (compact && ctx.model) {
      const proof = recoveryProofs.get(compact.id);
      const saved = proof?.sessionId === ctx.sessionManager.getSessionId() && proof.operationId === d?.operationId ? proof.bound : undefined;
      const bound = validRecoveryBound(saved) && saved.model === `${ctx.model.provider}/${ctx.model.id}` ? saved : undefined;
      const branch = ctx.sessionManager.getBranch(), before = branch.slice(0, branch.findIndex(e => e.id === compact.id));
      const kept = (retainedMessages(before, compact.firstKeptEntryId));
      actualEstimate = boundedContextTokens(messages, kept, bound);
      const window = Math.min(sessionWindow(ctx.sessionManager.getBranch()) ?? ctx.model.contextWindow, ctx.model.contextWindow);
      const reserve = outputReserve(ctx);
      const actual = actualEstimate.total;
      if (!fits(actual, reserve, window)) {
        const detail = compact.details as { handoff?: string; userQuotations?: UserQuotations } | undefined;
        warn(ctx, `恢复请求完整准入失败：正文约 ${textTokens(detail?.handoff ?? compact.summary)}、原话约 ${textTokens(detail?.userQuotations ? renderUserQuotations(detail.userQuotations) : "")}，实际系统/工具及全部 owner 注入合计约 ${actual}，输出余量 ${reserve}，窗口 ${window}。已阻止本次请求；已提交压缩仍保留，原始 session entries 未删除。`);
        ctx.abort();
        return;
      }
    }
    const item = [...pending.values()].findLast((i) => i.run.adopted?.compactionEntryId && i.run.contextSizes.after.providerReported === null);
    if (item && item.run.sessionId === ctx.sessionManager.getSessionId()) {
      const branch=ctx.sessionManager.getBranch(),at=branch.findIndex(e=>e.id===item.run.adopted?.compactionEntryId);
      const recovery=branch.slice(at+1).filter(e=>e.type==="custom_message"&&e.customType==="pi-session-compact:recovery-v1");
      const estimate=item.run.contextSizes.after.estimated as {systemAndTools:number;summary:number;retainedRecent:number;recoveryPackage:number;total:number};
      if(!includesRecovery(d,"pi-session-compact","pi-session-compact:recovery-v1"))estimate.recoveryPackage=contextTokens(convertToLlm(recovery.flatMap(e=>e.type==="custom_message"?[{role:"custom",customType:e.customType,content:e.content,display:e.display,details:e.details,timestamp:Date.parse(e.timestamp)}]:[])));
      estimate.total=actualEstimate.total;
      Object.assign(estimate, { method: actualEstimate.method, unboundedTotal: actualEstimate.unbounded, requestAdmission: actualEstimate });
      const before=(item.run.contextSizes.before.estimated as {total:number}).total;
      Object.assign(item.run.contextSizes,{compressionRatioEstimated:before/estimate.total,retainedFractionEstimated:estimate.total/before,tokensSavedEstimated:before-estimate.total});
      const increment=branch.slice(at+1).filter(e=>e.type==="message"||e.type==="custom_message"&&!recovery.includes(e));
      nextBusiness = { operationId: item.run.operationId, leaf: ctx.sessionManager.getLeafId(), requestId: randomUUID(), additionalContext: increment.length>0 };
      item.run.timings.pauseToNextBusinessRequestMs=performance.now()-item.started;
      item.run.timings.recoveryMs=performance.now()-item.started-(item.run.totalElapsedMs??0)-(item.run.timings.hostCommitMs??0);
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    lastBusiness = { sessionId: ctx.sessionManager.getSessionId(), leaf: event.messageEntryId, requestId: nextBusiness?.requestId ?? randomUUID(), usage: event.message.usage };
    if (!nextBusiness) return;
    const item = pending.get(nextBusiness.operationId);
    if (item && item.run.sessionId === lastBusiness.sessionId) {
      item.run.contextSizes.after.providerReported = { requestId: nextBusiness.requestId, leaf: nextBusiness.leaf, rawUsage: event.message.usage, comparable: !nextBusiness.additionalContext, additionalContext: nextBusiness.additionalContext };
      await persist(item, ctx);
      pending.delete(nextBusiness.operationId);
    }
    nextBusiness = undefined;
  });
  // A settled run is the only safe boundary: ctx.compact() aborts a running agent first.
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted || windowRun || !ctx.model) return;
    const configured = sessionWindow(ctx.sessionManager.getBranch());
    if (!configured) return;
    const sessionId = ctx.sessionManager.getSessionId(), window = Math.min(configured, ctx.model.contextWindow), frozen = epoch;
    const latest = () => ctx.sessionManager.getBranch().findLast((e) => e.type === "compaction")?.id ?? null;
    const used = ctx.getContextUsage()?.tokens ?? null;
    const guard = windowGuard?.sessionId === sessionId ? windowGuard : undefined;
    const action = windowAction(used, window, latest(), guard);
    if (action === "below") windowGuard = undefined;
    if (action === "warn") { guard!.warned = true; warn(ctx, `上下文约 ${fmt(used!)} tokens，仍超过本会话有效窗口 ${fmt(window)} 的 90%（${fmt(windowThreshold(window))}）。刚压缩过，不再立即压缩；回落到阈值以下或再次压缩后恢复自动触发，Pi 原生阈值仍按真实窗口兜底。`); }
    if (action !== "compact") return;
    windowRun = { sessionId };
    ctx.ui.notify(`pi-session-compact：上下文约 ${fmt(used!)} tokens，超过本会话有效窗口 ${fmt(window)} 的 90%（${fmt(windowThreshold(window))}），开始压缩。`, "info");
    const settle = (error?: Error) => {
      if (epoch !== frozen) return;
      windowRun = undefined;
      windowGuard = { sessionId, compactionId: latest(), warned: !!error };
      if (error) warn(ctx, `有效窗口自动压缩没有完成：${error.message}。回落到阈值以下或再次压缩前不再自动触发。`);
    };
    ctx.compact({ onComplete: () => settle(), onError: settle });
  });
  const outputReserve = (ctx: ExtensionContext): number => {
    const settings = pi.getSettings().compaction;
    return settings?.modelOverrides?.[`${ctx.model?.provider}/${ctx.model?.id}`]?.reserveTokens ?? settings?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  };
  const windowSizes = (ctx: ExtensionContext): string => {
    const branch = ctx.sessionManager.getBranch(), entry = branch.findLast(e => e.type === "compaction");
    const details = entry?.details as { handoff?: string; userQuotations?: UserQuotations } | undefined;
    const projection = ctx.sessionManager.buildSessionProjection();
    const body = textTokens(details?.handoff ?? entry?.summary ?? "");
    const quotes = details?.userQuotations?.version === 1 ? textTokens(renderUserQuotations(details.userQuotations)) : undefined;
    const recovery = projection.entries.filter(e => e.sourceEntry.type === "custom_message").flatMap(e => e.messages);
    const tail = projection.entries.filter(e => e.sourceEntry.type !== "compaction" && e.sourceEntry.type !== "custom_message").flatMap(e => e.messages);
    return `当前组成（估算 tokens）：正文 ${fmt(body)}，原话 ${quotes === undefined ? "旧格式未分列" : fmt(quotes)}，尾部 ${fmt(contextTokens(convertToLlm(tail).filter(m => m.role !== "system")))}，恢复包/通知 ${fmt(contextTokens(convertToLlm(recovery)))}，输出余量 ${fmt(outputReserve(ctx))}。`;
  };
  const windowCommand = async (value: string, ctx: ExtensionContext) => {
    const configured = sessionWindow(ctx.sessionManager.getBranch()), model = ctx.model;
    const describe = (set: number) => {
      const real = model?.contextWindow ?? set, window = Math.min(set, real);
      return `本会话有效窗口 ${fmt(set)} tokens（${model ? `${model.provider}/${model.id} 真实窗口 ${fmt(real)}` : "当前没有模型"}${window < set ? `，实际按 ${fmt(window)}` : ""}）。每次 agent 结束后上下文超过 ${fmt(windowThreshold(window))}（90%）自动压缩；完整恢复容量、余量门禁和保留尾部（${fmt(keepRecentFor(window))}）按这个窗口算。Pi 原生阈值仍按真实窗口兜底。`;
    };
    if (!value) { ctx.ui.notify((configured ? describe(configured) : `本会话没有设有效窗口，压缩由 Pi 原生阈值按模型真实窗口${model ? ` ${fmt(model.contextWindow)}` : ""}触发。`) + `\n${windowSizes(ctx)}`, "info"); return; }
    const parsed = parseWindow(value);
    if (parsed === undefined) { ctx.ui.notify(`无法识别窗口大小「${value}」；用 262k、262144、1m 这样的 token 数，或 off。`, "warning"); return; }
    if (parsed === "off") {
      if (configured) { pi.appendEntry(WINDOW_ENTRY, { version: 1, tokens: null }); publishStatus(ctx); }
      ctx.ui.notify(configured ? "已取消本会话有效窗口，压缩恢复由 Pi 原生阈值按模型真实窗口触发。" : "本会话没有设有效窗口。", "info");
      return;
    }
    if (!model) { ctx.ui.notify("当前没有模型，无法核对真实窗口，未设置。", "warning"); return; }
    if (parsed > model.contextWindow) { ctx.ui.notify(`有效窗口 ${fmt(parsed)} 大于 ${model.provider}/${model.id} 的真实窗口 ${fmt(model.contextWindow)}，未设置。`, "warning"); return; }
    let config: Config;
    try { config = await readConfig(getAgentDir()); }
    catch (error) { ctx.ui.notify(`压缩配置无效，未设置：${String(error)}`, "warning"); return; }
    for (const message of config.deprecatedSettings ?? []) warn(ctx, message);
    const system = getCurrentSystemMessage(convertToLlm(ctx.sessionManager.buildSessionProjection().messages));
    const active = new Set(pi.getActiveTools());
    const fixed = contextTokens([system ?? { role: "system", content: ctx.getSystemPrompt(), toolsAdded: pi.getAllTools().filter(t => active.has(t.name)).map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: 0 }]);
    const latest = ctx.sessionManager.getBranch().findLast(e => e.type === "compaction");
    const currentSummary = latest ? textTokens(latest.summary) : 0;
    const reserve = outputReserve(ctx);
    const minimum = minimumWindow(fixed, currentSummary, reserve);
    if (parsed < minimum) { ctx.ui.notify(`有效窗口 ${fmt(parsed)} 装不下压缩本身：系统提示与工具约 ${fmt(fixed)}、当前摘要与原话 ${fmt(currentSummary)}、保留尾部 ${fmt(keepRecentFor(parsed))} 、输出余量 ${fmt(reserve)} 要落在 90% 阈值以内，至少需要 ${fmt(minimum)}，未设置。`, "warning"); return; }
    pi.appendEntry(WINDOW_ENTRY, { version: 1, tokens: parsed });
    publishStatus(ctx);
    ctx.ui.notify(`已设置。${describe(parsed)}\n${windowSizes(ctx)}`, "info");
  };
  const showCommand = async (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.findLast((e): e is CompactionEntry => e.type === "compaction");
    if (!entry) { ctx.ui.notify("当前分支还没有压缩过，模型看到的是完整历史。", "info"); return; }
    const runLog = (entry.details as { runLog?: unknown } | undefined)?.runLog;
    let run: RunLog | undefined, note: string | undefined;
    if (typeof runLog === "string" && /^pi-session-compact\/runs\/[\w-]+\/[\w-]+\.json$/.test(runLog)) {
      try { run = JSON.parse(await readFile(join(getAgentDir(), runLog), "utf8")) as RunLog; }
      catch (error) { note = `运行日志读取失败：${String(error)}`; }
    }
    await present(ctx, "压缩后上下文", describeCompaction(entry, branch, run, note));
  };
  const nowCommand = async (value: string, ctx: ExtensionContext) => {
    if (manualRun) { warn(ctx, "已有手动压缩在进行中，请稍后再试。"); return; }
    const parsed = parseNow(value);
    const request = { sessionId: ctx.sessionManager.getSessionId(), mode: parsed.mode, consumed: false };
    manualRun = request;
    const clear = () => { if (manualRun === request) manualRun = undefined; };
    try {
      ctx.compact({ customInstructions: parsed.customInstructions, onComplete: clear, onError: (error) => { clear(); warn(ctx, `手动压缩失败：${String(error)}`); } });
    } catch (error) { clear(); throw error; }
  };
  const reserveCommand = async (value: string, ctx: ExtensionContext) => {
    const action = parseReserve(value);
    if (!action) { warn(ctx, "用法：/compaction reserve [write]"); return; }
    try {
      const { readReserveSettings, writeReserveSettings } = await import("./src/reserve-storage.ts");
      const agentDir = getAgentDir(), snapshot = await readReserveSettings(agentDir, ctx.cwd);
      const models = ctx.modelRegistry.getAvailable();
      const report = reserveReport(models, snapshot.global, snapshot.project, pi.getSettings(), ctx.isProjectTrusted());
      if (action === "report") { await present(ctx, "压缩阈值校对", describeReserve(report)); return; }
      const entries = Object.entries(report.changes);
      if (!entries.length) { ctx.ui.notify("全局模型 reserveTokens 覆盖已一致，无需写入。项目级覆盖仍请核对 /compaction reserve 报告。", "info"); return; }
      if (!ctx.hasUI) { warn(ctx, "写入需要确认框；请在 TUI 或支持确认的 RPC 客户端运行。"); return; }
      const details = entries.map(([key, patch]) => `${key}: reserveTokens ${snapshot.global.compaction?.modelOverrides?.[key]?.reserveTokens ?? "缺覆盖"} → ${patch.reserveTokens}, keepRecentTokens=${patch.keepRecentTokens}`).join("\n");
      if (!await ctx.ui.confirm("写入全局压缩阈值？", `${join(agentDir, "settings.json")}\n${details}\n\n先备份，再只修改以上模型的 token 设置。项目级覆盖不变；新开的 pi 才生效，正在运行的会话要重启。`)) { ctx.ui.notify("已取消，未写入。", "info"); return; }
      const backup = await writeReserveSettings(agentDir, ctx.cwd, models, report, snapshot);
      ctx.ui.notify(`已写入 ${entries.length} 项。备份：${backup}\n新开的 pi 才生效，正在运行的会话要重启。${report.project ? "项目级覆盖仍可能改变结果，请核对报告。" : ""}`, "info");
    } catch (error) { warn(ctx, `阈值校对/写入失败：${String(error)}`); }
  };
  const subcommands: Record<(typeof COMPACTION_SUBCOMMANDS)[number], (value: string, ctx: ExtensionContext) => Promise<void>> = { now: nowCommand, window: windowCommand, show: (_value, ctx) => showCommand(ctx), reserve: reserveCommand };
  pi.registerCommand("compaction", {
    description: "压缩：window [<tokens>|off] 设窗口，show 查看压缩，now [auto|main|small] [聚焦说明…] 立即压缩，reserve [write] 校对/确认后写入全局 90% 阈值",
    getArgumentCompletions: compactionCompletions,
    handler: async (args, ctx) => {
      const [first = ""] = args.trim().split(/\s+/, 1);
      const value = args.trim().slice(first.length).trim();
      const sub = COMPACTION_SUBCOMMANDS.find((s) => s === first.toLowerCase());
      if (sub) await subcommands[sub](value, ctx);
      else ctx.ui.notify("用法：/compaction window [<tokens>|off]，或 /compaction show，或 /compaction now [auto|main|small] [聚焦说明…]，或 /compaction reserve [write]", "warning");
    },
  });
}
const fmt = (value: number) => value.toLocaleString("en-US");
/** The repo's read-only long-text view (as in pi-model-prompts); other modes get the same text as a notice. */
async function present(ctx: ExtensionContext, title: string, body: string): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI) { const { showTextPanel } = await import("pi-li-uikit/text-panel"); await showTextPanel(ctx, { title, body, format: "plain" }); }
  else ctx.ui.notify(body, "info");
}
