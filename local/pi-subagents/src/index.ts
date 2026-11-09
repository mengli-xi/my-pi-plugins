import { bindMailbox } from "pi-session-inject/mailbox-v1/light";
import { SubagentMailboxTransport } from "./mailbox/transport.js";
import { checkMainMail, recordMainMail, terminalMainMail } from "./mailbox/main-source.js";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultSubagentsConfig } from "./config/schema.js";
import { loadSubagentsConfig } from "./config/load.js";
import type { ConfigLoadResultV1 } from "./config/types.js";
import { registerCollaborationTools } from "./tools/register.js";
import { getProcessServiceCellV1, assertSdkOnlyBackend } from "./host/service-cell.js";
import { hasStoredMainV1 } from "./host/recovery-presence.js";
import type { ProcessMainBindingV1 } from "./host/process-service.js";
import { mainRunFailedV1 } from "./host/main-turn-settlement.js";
import { createCompactReinjection } from "./host/compact-reinject.js";
import { SubagentStripV1 } from "./ui/strip.js";
import { registerSubagentMessageRenderersV1 } from "./ui/completion-renderer.js";
import { SubagentStatuslinePublisherV1 } from "./ui/statusline.js";
import type { TerminalOwner } from "pi-session-runtime/terminal-owner";
import type { EffectiveCaptureLease } from "pi-session-runtime/effective-context";

interface SessionStateV1 {
  readonly sessionId: string;
  readonly agentDirectory: string;
  readonly context: ExtensionContext;
  readonly config: Promise<ConfigLoadResultV1>;
  retired: boolean;
  runActive: boolean;
  compactDrain?: ReturnType<typeof setTimeout>;
  diagnostic?: string;
  pending?: Promise<ProcessMainBindingV1>;
  binding?: ProcessMainBindingV1;
  strip?: SubagentStripV1;
  statusline?: SubagentStatuslinePublisherV1;
  captureLease?: EffectiveCaptureLease;
  terminalOwner?: TerminalOwner;
}

const bindingAccess = getProcessServiceCellV1().bindingAccess ??= new Map<string, (ctx: ExtensionContext) => Promise<ProcessMainBindingV1>>();
const bindingKey = (ctx: ExtensionContext): string => JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile() ?? null]);
/** Explicit owner access for same-process extensions; the resolver retains all session/lifecycle fences. */
export function getSubagentBindingForContext(ctx: ExtensionContext): Promise<ProcessMainBindingV1> {
  const resolve = bindingAccess.get(bindingKey(ctx));
  if (!resolve) return Promise.reject(new Error("Subagent session is unavailable."));
  return resolve(ctx);
}

export default function subagentsExtension(pi: ExtensionAPI, bind: typeof bindMailbox = bindMailbox): void {
  let backendError: string | undefined;
  try { assertSdkOnlyBackend(); } catch (error) { backendError = error instanceof Error ? error.message : String(error); }
  let current: SessionStateV1 | undefined;
  let captureModule: typeof import("./context/effective.js") | undefined;
  let managerModule: Promise<typeof import("./ui/manager.js")> | undefined;
  const cell = getProcessServiceCellV1();
  const assertCurrent = (state: SessionStateV1): void => {
    if (current !== state || state.retired) throw new Error("Subagent session changed before initialization completed.");
  };
  const stateForContext = (ctx: ExtensionContext): SessionStateV1 => {
    if (!current || current.retired || current.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Subagent session is unavailable.");
    return current;
  };
  const ensureReady = (state: SessionStateV1): Promise<ProcessMainBindingV1> => {
    assertCurrent(state);
    if (state.binding) return Promise.resolve(state.binding);
    state.pending ??= (async () => {
      const loaded = await state.config;
      assertCurrent(state);
      const config = loaded.ok ? loaded.config : defaultSubagentsConfig();
      const userConfig = loaded.ok ? loaded.userConfig : defaultSubagentsConfig();
      let creation = cell.promise;
      if (!cell.service) {
        creation ??= cell.promise = (async () => {
          const { SubagentProcessServiceV1 } = await import("./host/process-service.js");
          return SubagentProcessServiceV1.create({ config: userConfig, agentDirectory: state.agentDirectory });
        })();
        try { cell.service = await creation; }
        catch (error) { if (cell.promise === creation) cell.promise = undefined; throw error; }
      }
      assertCurrent(state);
      const service = cell.service;
      const binding = await service.attach(pi, state.context, config, mailbox);
      if (current !== state || state.retired) {
        if (binding.context === state.context) service.detach(pi, state.sessionId);
        throw new Error("Subagent session changed before initialization completed.");
      }
      binding.host.setWorkDiagnostic(backendError ?? (!loaded.ok ? loaded.diagnostic.message : undefined));
      state.binding = binding;
      binding.terminalOwner = state.terminalOwner;
      // A first spawn may create the owner in the middle of a Main model run.
      if (state.runActive) service.signalMainRunStarted(state.sessionId);

      state.strip?.invalidate();
      state.statusline?.publish();
      return binding;
    })().catch((error) => {
      state.pending = undefined;
      if (!state.retired) state.diagnostic = `Subagent service failed: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    });
    return state.pending;
  };
  // Source identity/restoration must exist before A's session_start can replay
  // old notices. This is initialization, not a retry or an ACK debt latch.
  pi.on("session_start", async (_event, ctx) => {
    current?.captureLease?.retire();
    const state: SessionStateV1 = {
      sessionId: ctx.sessionManager.getSessionId(), agentDirectory: getAgentDir(), context: ctx,
      config: loadSubagentsConfig({ agentDirectory: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }),
      retired: false, runActive: false,
    };
    current = state;
    bindingAccess.set(bindingKey(ctx), ensureForContext);
    await mailbox.bindContext(ctx);
    assertCurrent(state);
  });
  const mailbox = new SubagentMailboxTransport(pi, getAgentDir(), {
    checkCurrent: (mail, _point, fence) => {
      const binding = cell.service?.binding(fence.session.id);
      if (!binding || !mailbox.current(fence)) return { kind: "hold", reason: "Subagent Main source binding is unavailable" };
      return checkMainMail(binding, mail);
    },
    onRecorded: async (notice, fence) => {
      if (!mailbox.current(fence)) throw new Error("stale Subagent Main mailbox callback");
      const binding = await ensureReady(stateForContext(current!.context));
      if (binding.mainSessionId !== notice.scope.sessionId) throw new Error("Subagent Main ACK scope mismatch");
      await recordMainMail(binding, notice);
      cell.service?.signalMainIdle(binding.mainSessionId);
    },
    onTerminal: async (evidence, fence) => {
      if (!mailbox.current(fence)) throw new Error("stale Subagent Main mailbox callback");
      const binding = await ensureReady(stateForContext(current!.context));
      if (binding.mainSessionId !== evidence.scope.sessionId) throw new Error("Subagent Main terminal scope mismatch");
      await terminalMainMail(binding, evidence);
    },
    beforeRun: async ({ fence }) => {
      const binding = cell.service?.binding(fence.session.id);
      if (binding && mailbox.current(fence)) {
        // before_agent_start precedes agent_start. Goal can consume its owed
        // marker here, so reserve this run's opportunity before its guard does
        // another fallback check. Only context observation can settle cards.
        binding.turn.runStarted();
        await binding.turn.settle({ host: binding.host, mainSessionId: binding.mainSessionId, at: new Date().toISOString(), branch: binding.append?.session.getBranch() });
      }
    },
  }, bind);
  const ensureForContext = (ctx: ExtensionContext): Promise<ProcessMainBindingV1> => ensureReady(stateForContext(ctx));
  const openManager = async (state: SessionStateV1, target?: string): Promise<void> => {
    try {
      const binding = await ensureReady(state);
      managerModule ??= import("./ui/manager.js").catch((error) => { managerModule = undefined; throw error; });
      const { showSubagentManagerV1 } = await managerModule;
      assertCurrent(state);
      const candidates = target ? binding.host.snapshot().agents.filter(item => [item.agent.agent_id, item.agent.task_path, item.agent.task_name].includes(target)) : [];
      if (target && candidates.length === 0) throw new Error(`找不到这个 Agent：${target}。请检查当前会话、Agent ID 或 task path；不会自动转换或删除旧存储。`);
      if (target && candidates.length !== 1) throw new Error(`Subagent target is ambiguous: ${target}`);
      await showSubagentManagerV1(state.context, binding, candidates[0]?.agent.agent_id);
    } catch (error) {
      if (current === state && !state.retired) state.context.ui.notify(state.diagnostic ?? `Unable to open Subagents: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  registerSubagentMessageRenderersV1(pi,(details,content)=>{void current?.binding?.runtime.markClickedInbox(details,content).catch(error=>current?.context.ui.notify(String(error),"warning"));});
  registerCollaborationTools(pi, async (input) => {
    try {
      if (!input.context) throw new Error("Subagent tool context is unavailable.");
      input.signal?.throwIfAborted();
      const state = stateForContext(input.context);
      const config = await state.config;
      if (["spawn_agent", "send_input", "resume_agent"].includes(input.tool) && (backendError || !config.ok)) {
        const message = backendError ?? (!config.ok ? config.diagnostic.message : "配置无效");
        return { details: { version: 1, tool: input.tool, outcome: "rejected", host_revision: state.binding?.host.host_revision ?? 0, error: { code: "config-invalid", message } } };
      }
      await ensureReady(state);
      input.signal?.throwIfAborted();
      assertCurrent(state);
      return cell.service!.executor(state.sessionId)(input);
    } catch (error) {
      return { details: { version: 1, tool: input.tool, outcome: "rejected", host_revision: 0, error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } } };
    }
  });
  pi.registerCommand("subagents", {
    description: "Open Running/Done or /subagents <target> (Agent ID or task path, including closed history)",
    getArgumentCompletions: prefix => {
      if (!current?.binding || current.retired) return null;
      const items = current.binding.host.snapshot().agents.flatMap(item => [{ value: item.agent.task_path, label: item.agent.task_path, description: item.agent.task_name }, { value: item.agent.agent_id, label: item.agent.agent_id, description: item.agent.task_path }]).filter(item => item.value.startsWith(prefix));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      try { await openManager(stateForContext(ctx), args.trim() || undefined); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });



  pi.on("session_start", async (_event, ctx) => {
    const state = stateForContext(ctx);
    if (ctx.hasUI) {
      // The small terminal handoff stays deferred until a UI binding; execution remains lazy.
      const terminalModule = await import("pi-session-runtime/terminal-owner");
      assertCurrent(state);
      const open = () => { void openManager(state); };
      ctx.ui.setWidget("pi-subagents", (tui, theme) => {
        state.strip?.dispose();
        state.terminalOwner ??= new terminalModule.TerminalOwner(tui, ctx.ui, () => pi.getSettings().theme);
        if (state.binding) state.binding.terminalOwner = state.terminalOwner;
        return state.strip = new SubagentStripV1(tui, theme, () => state.retired ? undefined : state.binding, open);
      }, { placement: "aboveEditor" });
      state.statusline = new SubagentStatuslinePublisherV1(pi, ctx, () => state.retired ? undefined : state.binding, open);
    }
    try {
      const loaded = await state.config;
      assertCurrent(state);
      if (backendError || !loaded.ok) { state.diagnostic = backendError ?? (!loaded.ok ? loaded.diagnostic.message : "配置无效"); ctx.ui.notify(state.diagnostic, "error"); }
      // Existing durable state (including pending delivery) always takes the full recovery path.
      if (cell.service?.binding(state.sessionId) || await hasStoredMainV1(state.agentDirectory, state.sessionId)) await ensureReady(state);
    } catch (error) {
      if (current === state && !state.retired) {
        state.diagnostic = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(state.diagnostic, "error");
      }
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (current?.sessionId === sessionId) current.runActive = true;
    cell.service?.signalMainRunStarted(sessionId);
  });
  pi.on("context", (event, ctx) => { cell.service?.observeMainContext(ctx.sessionManager.getSessionId(), event.messages); });
  pi.on("context_with_system", async (event, ctx) => {
    const state = current;
    if (!state || state.retired) return;
    // Keep delayed imports at the extension entry's Jiti resolution boundary.
    captureModule ??= await import("./context/effective.js");
    await captureModule.observeMainEffectiveRequest(pi, event, ctx, state);
  });
  const reinjectCompactState = createCompactReinjection(pi, ctx => current && !current.retired && current.sessionId === ctx.sessionManager.getSessionId() ? current.binding : undefined);
  const drainAfterCompact = (ctx: ExtensionContext): void => {
    const state = current;
    if (!state || state.retired || state.sessionId !== ctx.sessionManager.getSessionId() || !state.binding) return;
    clearTimeout(state.compactDrain);
    // session_compact/failed still run inside Pi's compaction guard. Let that
    // guard unwind, then release the original completion queue, never its copy.
    const drain = (): void => {
      state.compactDrain = undefined;
      if (current !== state || state.retired) return;
      if (ctx.isIdle()) cell.service?.signalMainIdle(state.sessionId);
      else if (!state.runActive) state.compactDrain = setTimeout(drain, 10);
      // An active Main already owns the normal agent_settled drain boundary.
    };
    state.compactDrain = setTimeout(drain, 0);
  };
  pi.on("session_compact", (event, ctx) => {
    captureModule?.getEffectiveContextStore().invalidate(ctx.sessionManager.getSessionId(), "native-compaction");
    reinjectCompactState(event, ctx);
    drainAfterCompact(ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => { drainAfterCompact(ctx); });
  const confirmCapture = (_event: unknown, ctx: ExtensionContext) => {
    if (current && !current.retired && current.sessionId === ctx.sessionManager.getSessionId()) current.captureLease?.confirmRequest(ctx.signal);
  };
  pi.on("before_provider_request", confirmCapture);
  pi.on("after_provider_response", confirmCapture);
  pi.on("agent_end", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (current?.sessionId === sessionId) { current.runActive = false; current.captureLease?.endRequest(); }
    await cell.service?.signalMainRunEnded(sessionId, mainRunFailedV1(event.messages, ctx.signal?.aborted === true), { pi, ctx });
  });
  pi.on("agent_settled", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (current?.sessionId === sessionId) current.runActive = false;
    if (event.aborted) cell.service?.signalMainRunEnded(sessionId, true);
    cell.service?.signalMainIdle(sessionId);
  });
  const reclaimView = async (reason: "return" | "quit" = "return") => { const runtime = current?.binding?.runtime; if (runtime && "closeView" in runtime) await runtime.closeView(reason); };
  pi.on("session_before_switch", () => reclaimView());
  pi.on("session_before_fork", () => reclaimView());
  pi.on("session_before_tree", () => reclaimView());
  pi.on("session_shutdown", async (event, ctx) => {
    if (bindingAccess.get(bindingKey(ctx)) === ensureForContext) bindingAccess.delete(bindingKey(ctx));
    const closeReason = event.reason === "quit" ? "quit" : "return";
    await reclaimView(closeReason);
    const sessionId = ctx.sessionManager.getSessionId();
    const state = current?.sessionId === sessionId ? current : undefined;
    if (state) {
      state.retired = true;
      clearTimeout(state.compactDrain);
      state.captureLease?.retire();
      state.terminalOwner?.dispose(closeReason);
      state.strip?.dispose();
      state.statusline?.dispose();
      if (ctx.hasUI) ctx.ui.setWidget("pi-subagents", undefined);
      await state.pending?.catch(() => undefined);
      if (current === state) current = undefined;
    }
    await cell.service?.endMainSession(pi, sessionId);
    if (event.reason === "quit" && cell.service) {
      await cell.service.close();
      cell.service = undefined;
      cell.promise = undefined;
    }
  });
}
