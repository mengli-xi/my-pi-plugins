import { createLoadedSkillsRenderer } from "../../../pi-skills/loaded-skill-entry.ts";
import { registerLifecycleRenderer, registerNotificationStatusRenderer } from "../../../pi-processes/src/integrations/lifecycle-entry.ts";
import { registerProcessTool } from "../../../pi-processes/src/tool/register.ts";
import { registerSubagentMessageRenderersV1 } from "../../../pi-subagents/src/ui/completion-renderer.ts";
import { findRendered } from "./component-contract.mjs";

const skillType = "pi-skills:binding-v1";
const processType = "process-event-v2";
export function installProfileRenderers(pi, view, log) {
  view.profileComponents = new Map();
  view.profileEntryComponents = new Map();
  view.profileTokens ??= new Map();
  const observe = (method, type, renderer) => pi[method](type, (...args) => {
    const component = renderer(...args);
    if (component) {
      view.profileComponents.set(type, component);
      if (method === "registerEntryRenderer") view.profileEntryComponents.set(type, component);
    }
    return component;
  });
  for (const type of [skillType, "pi-skill-mentions:binding-v1", "pi-skills:agent-read-v1"])
    observe("registerEntryRenderer", type, createLoadedSkillsRenderer(type));
  const observer = new Proxy(pi, { get(target, key) {
    if (key === "registerEntryRenderer" || key === "registerMessageRenderer")
      return (type, renderer) => observe(key, type, renderer);
    return Reflect.get(target, key);
  } });
  registerLifecycleRenderer(observer);
  registerNotificationStatusRenderer(observer);
  registerSubagentMessageRenderersV1(observer);
  registerProcessTool(pi, () => undefined); // rendering only; no ProcessHost/tool execution

  const cases = {
    skills: { type: skillType, summary: (token) => token,
      data: (token) => ({ version: 1, key: token, text: token,
        skills: [{ name: token, path: `/fixture/${token}/SKILL.md`, contents: `ENTRY_BODY_${token}` }] }) },
    "skills-legacy": { type: "pi-skill-mentions:binding-v1", summary: (token) => token,
      data: (token) => ({ version: 1, key: token, text: token,
        skills: [{ name: token, path: `/fixture/${token}/SKILL.md`, contents: `ENTRY_BODY_${token}` }] }) },
    "skills-read": { type: "pi-skills:agent-read-v1", summary: (token) => token,
      data: (token) => ({ version: 1, source: "agent-read", toolCallId: token,
        skill: { name: token, path: `/fixture/${token}/SKILL.md`, contents: `ENTRY_BODY_${token}` } }) },
    processes: { type: processType, summary: (token) => token,
      data: (token) => ({ version: 2, kind: "terminal", process: { id: "proc_00000000000000000000000000", name: token, kind: "process", state: "succeeded",
          commandPreview: "printf fixture", commandTruncated: false, cwd: view.cwd,
          startedAt: "2026-10-16T00:00:00.000Z", endedAt: "2026-10-16T00:00:00.001Z", runtimeMs: 1,
          stdinOpen: false, continuation: { mode: "detached" }, watches: { count: 0, keys: [], failedKeys: [] },
          logs: { revision: 0, earliestSequence: 0, nextSequence: 0, droppedBytes: 0, droppedLines: 0 },
          terminal: { outcome: "succeeded", exitCode: 0, signal: null } },
        text: `Process '${token}' succeeded.`, eventSequence: 1,
        terminal: { outcome: "succeeded", cause: "completed", durationMs: 1 }, stdout: [`ENTRY_BODY_${token}`] }) },
  };
  for (const [name, spec] of Object.entries(cases)) {
    pi.registerCommand(`fixture-entry-${name}`, { description: `Use the production ${name} EntryRenderer`, handler() {
      const token = `ENTRY_${name.toUpperCase()}_${view.role.toUpperCase()}_${view.entrySequence = (view.entrySequence ?? 0) + 1}`;
      view.profileType = spec.type; view.providerType = spec.type;
      view.profileHistory = false; view.profileTokens.set(spec.type, token);
      pi.appendEntry(spec.type, spec.data(token));
      log({ event: "profile-entry", role: view.role, name, token, type: spec.type });
    } });
    pi.registerCommand(`fixture-history-entry-${name}`, { description: `Click a restored production ${name} entry`, handler() {
      view.profileType = spec.type; view.providerType = spec.type; view.profileHistory = true;
      const host = findRendered(view.tui, view.profileTokens.get(spec.type), view.tui.terminal.columns);
      if (!host) throw new Error(`restored ${name} entry is not in the public TUI tree`);
      const rows = host.render(view.tui.terminal.columns);
      log({ event: "profile-entry-history", role: view.role, name, type: spec.type, token: view.profileTokens.get(spec.type), rows });
    } });
  }
  pi.registerCommand("fixture-process-message", { description: "Use the production legacy Processes MessageRenderer", handler() {
    const token = `ENTRY_LEGACY_${view.role.toUpperCase()}_${view.entrySequence = (view.entrySequence ?? 0) + 1}`;
    view.profileType = processType; view.providerType = processType;
    view.profileHistory = false;
    pi.sendMessage({ customType: processType, content: token, display: true, details: cases.processes.data(token) });
    log({ event: "profile-entry", role: view.role, name: "legacy", token, type: processType });
  } });
  pi.registerCommand("fixture-completion-message", { description: "Use the production Subagents completion renderer", handler() {
    const token = `ENTRY_COMPLETION_${view.role.toUpperCase()}_${view.entrySequence = (view.entrySequence ?? 0) + 1}`;
    view.profileType = "subagent-completion-v1"; view.providerType = view.profileType;
    view.profileHistory = false;
    pi.sendMessage({ customType: view.profileType, content: `<subagent-completion task_path="${token}" outcome="completed" reason="normal-final"><summary>${token}</summary><result>ENTRY_BODY_${token}</result></subagent-completion>`, display: true });
    log({ event: "profile-entry", role: view.role, name: "completion", token, type: view.profileType });
  } });
  pi.registerShortcut("alt+e", { description: "Click the actual profile renderer", handler() {
    const component = (view.profileHistory ? view.profileEntryComponents : view.profileComponents).get(view.profileType);
    const click = { type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false };
    log({ event: "profile-click", role: view.role, type: view.profileType, clicked: component?.handleMouse?.(click)?.handled === true });
  } });
  pi.registerCommand("fixture-mailbox", { description: "Use the production Subagents mailbox MessageRenderer", handler() {
    const token = `MAILBOX_${view.role.toUpperCase()}`;
    pi.sendMessage({ customType: "subagent-mailbox-v1", content: token + "\nMailbox detail", display: true });
    log({ event: "mailbox-render", role: view.role, token });
  } });
  pi.registerCommand("fixture-hidden-entry", { description: "Keep native hidden metadata invisible", handler() {
    const size = (node) => 1 + (node.children ?? []).reduce((total, child) => total + size(child), 0);
    const before = size(view.tui);
    pi.appendEntry("process-notification-status-v1", { version: 1 });
    pi.appendEntry("process-notification-receipt-v1", { version: 1 });
    pi.appendEntry("fixture-no-renderer", { shouldStayHidden: true });
    log({ event: "hidden-entry", role: view.role, unchanged: size(view.tui) === before });
  } });
}
