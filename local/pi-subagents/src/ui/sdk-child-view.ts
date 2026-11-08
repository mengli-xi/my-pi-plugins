import { registerSubagentMessageRenderersV1 } from "./completion-renderer.js";
import { randomUUID } from "node:crypto";
import { InlineToastController } from "pi-li-uikit/inline-toast";
import { join } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ManagedInteractive, type ManagedViewCloseReason } from "pi-session-runtime/managed-interactive";
import type { ManagedCommand, InputPolicy } from "pi-session-runtime/input-policy";
import type { TerminalOwner } from "pi-session-runtime/terminal-owner";
import type { AgentId } from "../domain/types.js";
import type { SdkRuntimeControllerV1 } from "../runtime/sdk-controller.js";
import type { FrozenProfileV1 } from "../persistence/types.js";
import { childExecutionFactories, childPresentationFactories } from "../runtime/factory-catalog.js";

const BLOCKED_ACTIONS: InputPolicy["blockedActions"] = [
  "app.model.select", "app.model.cycleForward", "app.model.cycleBackward", "app.thinking.cycle", "app.thinking.save",
  "app.session.new", "app.session.tree", "app.session.fork", "app.session.resume", "app.editor.external", "app.message.dequeue",
];

export function subagentCommands(view: ManagedInteractive, runtime: AgentSessionRuntime, profile: FrozenProfileV1, historical: boolean, resume: () => Promise<void>): ManagedCommand[] {
  const notify = (text: string) => runtime.session.extensionRunner.getUIContext().notify(text, "info");
  const mailbox = runtime.session.extensionRunner.getRegisteredCommands().find(command => command.name === "mailbox");
  return [
    ...(mailbox ? [{ name: "mailbox", description: mailbox.description, acceptsArguments: true,
      getArgumentCompletions: mailbox.getArgumentCompletions ?? (() => null), run: "native" as const }] : []),
    ...["subagent", "exit", "quit"].map(name => ({ name, description: "Return to Main", run: () => view.requestReturn() })),
    { name: "resume-agent", description: "Restore this Agent to open idle; send your draft separately", run: resume },
    ...["copy", "session", "hotkeys", "changelog"].map(name => ({ name, description: `Show child ${name}`, run: "native" as const })),
    { name: "compact", description: "Compact child context; optional free-text instructions", acceptsArguments: true, getArgumentCompletions: () => null,
      run: historical ? () => notify("Agent 已关闭，先恢复再发送；使用 /resume-agent 恢复后再压缩") : "native" },
    { name: "model", description: "Show frozen model (read-only)", acceptsArguments: true, getArgumentCompletions: () => null,
      run: () => notify(`Frozen model: ${profile.provider}/${profile.model}. Model changes are unavailable in Subagents.`) },
    { name: "thinking", description: "Show frozen reasoning effort (read-only)", acceptsArguments: true, getArgumentCompletions: () => null,
      run: () => notify(`Frozen thinking: ${profile.reasoning_effort}. Effort changes are unavailable in Subagents.`) },
    { name: "help", description: "Show Subagent commands and return keys", run: () => notify("/resume-agent restores without sending · Enter sends immediately · Alt+Enter queues a new Task (see /hotkeys for your binding) · /mailbox status|resume|recover <session-id> · /copy /session /compact [instructions] /hotkeys /changelog /help · /model and /thinking are read-only · Alt+/ or /subagent returns to Main · Ctrl+C interrupts when busy, returns when idle · Empty Ctrl+D returns") },
  ];
}

async function historyRuntime(controller: SdkRuntimeControllerV1, agentId: AgentId, view: ManagedInteractive) {
  const assembly = await import("pi-session-runtime/session-assembly");
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = assembly.getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
  const partition = controller.options.host.snapshot().agents.find(item => item.agent.agent_id === agentId);
  if (!partition) throw new Error("Subagent no longer exists");
  const profile = partition.agent.profile, agentDir = controller.options.agentDir;
  const source = SessionManager.open(join(controller.options.host.options.store.mainRoot, partition.agent.conversation.relative_path));
  const header = source.getHeader();
  if (!header) throw new Error("Subagent history has no native session header");
  const manager = SessionManager.inMemory(profile.cwd, {}, [header, ...source.getEntries()]);
  // History is presentation-only, including legacy profiles without an SDK grant.
  // Never install provider execution merely to display persisted native entries.
  const extensions: import("@earendil-works/pi-coding-agent").ExtensionFactory[] = [];
  extensions.push(...await childPresentationFactories(profile, view.lifecycle, partition.agent.task_name), pi=>registerSubagentMessageRenderersV1(pi,(details,content)=>{void controller.markClickedInbox(details,content).catch(error=>controller.options.reportOperationalError?.({operation:"view-read-receipt",error}));}), view.extension);
  return createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory(structuredClone(controller.options.settings()), { projectTrusted: profile.project_trusted });
    settingsManager.applyOverrides({ quietStartup: true, doubleEscapeAction: "none", enableSkillCommands: false });
    const services = await createAgentSessionServices({ cwd: profile.cwd, agentDir, settingsManager, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPrompt: "",
      disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], extensionFactories: extensions,
    } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [],
      model: services.modelRuntime.getModel(profile.provider, profile.model), thinkingLevel: profile.reasoning_effort });
    await result.session.bindExtensions({ mode: "print", shutdownHandler: view.requestReturn });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: profile.cwd, agentDir, sessionManager: manager });
}

export async function showSdkChildView(controller: SdkRuntimeControllerV1, agentId: AgentId, owner: TerminalOwner, bindingGeneration: number, setClose: (close: (reason: ManagedViewCloseReason) => Promise<void>) => void) {
  const host = controller.options.host;
  const partition = host.snapshot().agents.find(item => item.agent.agent_id === agentId);
  if (!partition) throw new Error("Subagent no longer exists");
  const caller = { kind: "user" as const, main_session_id: host.main_session_id, binding_generation: bindingGeneration, manager_generation: 1 };
  let view: ManagedInteractive | undefined, cancelled = false, refresh = false, draft = controller.viewDrafts.get(agentId) ?? "", rejectedDraft = draft;
  const report = (error: unknown) => controller.options.reportOperationalError?.({ operation: "child-view", error });
  setClose(async reason => { cancelled = true; await view?.close(reason); });
  do {
    refresh = false;
    let child = await controller.childForView(agentId);
    const deadline = Date.now() + 30_000;
    while (!child && !cancelled && host.snapshot().agents.find(item => item.agent.agent_id === agentId)?.agent.current_task_id) {
      if (Date.now() >= deadline) throw new Error("Subagent execution is not ready to open");
      await new Promise(resolve => setTimeout(resolve, 20));
      child = await controller.childForView(agentId);
    }
    if (cancelled) return;
    view = child?.view ?? new ManagedInteractive(report, () => controller.requestInterrupt(agentId));
    const runtime = child?.runtime ?? await historyRuntime(controller, agentId, view);
    const current = view;
    if (cancelled) { if (!child) await runtime.dispose(); return; }
    if (!child || draft) current.draft = draft;
    let submission: Readonly<Record<string, unknown>> | undefined, status = "";
    let toast: InlineToastController | undefined;
    const ui = () => runtime.session.extensionRunner.getUIContext();
    const refreshExecution = async () => {
      if (!child && host.snapshot().agents.find(item => item.agent.agent_id === agentId)?.agent.lifecycle === "open" && await controller.childForView(agentId) && current.attached && !cancelled) {
        refresh = true;
        await current.close();
      }
    };
    const inputStatus = () => {
      if (!submission || !current.attached) return;
      const item = host.snapshot().agents.find(item => item.agent.agent_id === agentId);
      const task = item?.tasks.find(task => task.task_id === submission!.task_id);
      const mail = item?.mailbox.find(mail => mail.message_id === submission!.submission_id);
      const text = mail?.state === "cancelled" || task?.interrupt_requested_at ? "已接纳，已取消"
        : mail ? mail.state === "consumed" || mail.state === "injected" ? "已开始" : runtime.session.isCompacting ? "已接纳，等待压缩结束" : "已接纳，等待工具 / 执行位"
        : task?.started_at ? "已开始" : "已接纳，等待执行位";
      if (status === text) return;
      status = text;
      toast ??= new InlineToastController(ui(), { key: "pi-subagents:input" });
      toast.show(text, { durationMs: text === "已开始" ? 3000 : 0 });
    };
    const policy: InputPolicy = {
      commands: subagentCommands(current, runtime, partition.agent.profile, !child, async () => {
        const result = await host.resumeAgent({ request_id: randomUUID(), caller, input: { target: agentId } });
        if (!result.ok) throw new Error(result.error.message);
        ui().setEditorText(rejectedDraft);
        ui().notify("Agent 已恢复为空闲；按 Enter 发送草稿", "info");
        // Resume only rebinds the native view; input separately admits execution.
        void refreshExecution().catch(report);
      }), blockedActions: BLOCKED_ACTIONS, returnKey: "alt+/",
      busy: () => child?.busy === true || runtime.session.isCompacting,
      leave: () => current.requestReturn(),
      unsupported: command => command === "side" ? "Return to Main before opening /side" : `/${command} is unavailable in a Subagent. Use /help for supported commands.`,
      interrupt: () => controller.requestInterrupt(agentId, child?.identity.generation),
      admit: async (text, intent) => {
        try { submission = await controller.admitViewInput(agentId, caller, text, intent, randomUUID()); }
        catch (error) {
          rejectedDraft = text;
          const lifecycle = host.snapshot().agents.find(item => item.agent.agent_id === agentId)?.agent.lifecycle;
          if (lifecycle === "closed" || lifecycle === "closing") throw new Error("Agent 已关闭，先恢复再发送");
          throw error;
        }
        rejectedDraft = "";
        try { inputStatus(); } catch (error) { report(error); }
      },
    };
    const timer = setInterval(() => { try { inputStatus(); } catch (error) { report(error); } void refreshExecution().catch(report); }, 100);
    timer.unref?.();
    const detach = current.lifecycle.onDetach(() => { clearInterval(timer); toast?.dispose(); toast = undefined; });
    current.onLoaded=()=>controller.markViewLoaded(agentId).catch(report);
    try { await current.open(runtime, owner, policy); draft = current.draft; controller.viewDrafts.set(agentId, draft); }
    finally { current.onLoaded=undefined; clearInterval(timer); detach(); if (!child) await runtime.dispose(); }
  } while (refresh && !cancelled);
}
