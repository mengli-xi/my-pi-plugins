import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { EditorPanel } from "pi-li-uikit/editor-panel";
import { searchSelectScreen } from "pi-li-uikit/search-select";
import type { ProcessMainBindingV1 } from "../host/process-service.js";
import { agentPresentation, type AgentPresentation, type AgentTab, type AgentRow } from "./agent-presentation.js";
import { layoutSubagentStripV1 } from "./strip.js";
import { unreadCompletionsForAgentV1 } from "../persistence/unread.js";

export interface SubagentUiResult { action: "close" | "conversation" | "interrupt" | "close-agent" | "resume" | "delete"; agentId?: string }
function safe(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\u0000-\u001f\u007f-\u009f]+/gu, " ").slice(0,512); }
function caller(binding: ProcessMainBindingV1) { return { kind: "user" as const, main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 }; }
function projection(binding: ProcessMainBindingV1) {
  const snapshot = binding.host.snapshot();
  return agentPresentation(snapshot, new Map(snapshot.agents.flatMap(item => {
    const resident = binding.runtime.residency?.(item.agent.agent_id); return resident ? [[item.agent.agent_id, resident] as const] : [];
  })));
}
function elapsed(row: AgentRow) {
  const task = row.task ?? row.latest; if (!task) return "—";
  const seconds = Math.max(0, Math.floor(((task.phase === "settled" ? Date.parse(task.settled_at ?? task.admitted_at) : Date.now()) - Date.parse(task.started_at ?? task.admitted_at)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m${seconds%60}s` : `${Math.floor(seconds/3600)}h${Math.floor(seconds%3600/60)}m`;
}
function usage(row: AgentRow) { return row.partition.completions.reduce((sum,c) => sum + Math.max(c.usage.total_tokens, c.usage.input_tokens+c.usage.output_tokens+c.usage.cache_read_tokens+c.usage.cache_write_tokens),0); }
function tokens(n: number) { return n < 1000 ? `${n}t` : n < 1_000_000 ? `${(n/1000).toFixed(n<10000?1:0)}kt` : `${(n/1_000_000).toFixed(1)}Mt`; }
function label(row: AgentRow) { return `${row.partition.agent.depth === 1 ? "" : "  ↳ "}${row.partition.agent.task_name}`; }

export class SubagentManagerV1 implements Component, Focusable {
  readonly wantsMouse = true;
  private panel!: EditorPanel<"agents">;
  private presentation: AgentPresentation;
  private tab: AgentTab;
  private focusedValue = false;
  private replacing = false;
  private tabHits: { start: number; end: number; tab: AgentTab; row: number }[] = [];
  private notice?: string;
  private readonly selection: {tab?:AgentTab;selectedId?:string};
  private readonly timer: ReturnType<typeof setInterval>;
  readonly tui: TUI; private readonly theme: Theme; readonly binding: ProcessMainBindingV1; readonly done: (result: SubagentUiResult) => void;
  constructor(tui: TUI, theme: Theme, binding: ProcessMainBindingV1, done: (result: SubagentUiResult) => void, initialNotice?: string, selection: {tab?:AgentTab;selectedId?:string} = {}) {
    this.tui=tui; this.theme=theme; this.binding=binding; this.done=done; this.selection=selection;
    this.presentation = projection(binding); this.tab = selection.tab ?? (this.presentation.counts.active ? "running" : this.presentation.counts.done ? "done" : "running");
    this.notice = initialNotice; this.makePanel(selection.selectedId);
    this.timer = setInterval(() => { if (this.focusedValue) this.tui.requestRender(); }, 250); this.timer.unref?.();
  }
  private makePanel(initial?: string) {
    this.panel = new EditorPanel({ tui: this.tui, theme: this.theme, initialScreen: "agents", maxVisible: 12, getScreen: () => this.screen(initial), onClose: () => { if (!this.replacing) this.done({action:"close"}); } });
    this.panel.focused = this.focusedValue;
  }
  private update() {
    const selected = this.panel.selectedItemId, oldRows = this.presentation.tabs[this.tab], next = projection(this.binding);
    const oldIds=oldRows.map(row=>row.partition.agent.agent_id).join("|"), newIds=next.tabs[this.tab].map(row=>row.partition.agent.agent_id).join("|");
    this.presentation = next; this.selectedCached = selected; this.selection.selectedId=selected;
    if (oldIds !== newIds) {
      const rows = next.tabs[this.tab], oldIndex = Math.max(0,oldRows.findIndex(row => row.partition.agent.agent_id === selected));
      const initial = rows.some(row => row.partition.agent.agent_id === selected) ? selected : rows[Math.min(oldIndex,Math.max(0,rows.length-1))]?.partition.agent.agent_id;
      this.replacing = true; this.panel.dispose(); this.replacing = false; this.makePanel(initial);
    }
  }
  get focused() { return this.focusedValue; }
  set focused(value: boolean) { this.focusedValue = value; this.panel.focused = value; }
  get selectedId() { return this.panel.selectedItemId; }
  setAvailableHeight(rows: number) { this.panel.setAvailableHeight(rows); }
  setScreenOrigin(row: number,column: number) { this.panel.setScreenOrigin(row,column); }
  render(width: number) {
    this.update(); const rendered = this.panel.render(width); this.tabHits = [];
    rendered.forEach((line,index) => {
      const text = stripTerminalSequences(line);
      if (text.includes("Running") && text.includes("Done")) for (const tab of ["running","done"] as const) {
        const title = tab === "running" ? "Running" : "Done", start = text.indexOf(title);
        this.tabHits.push({ start, end:start+title.length, tab, row:index });
      }
    });
    return rendered;
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.focused && event.type === "press" && event.button === "left") {
      const hit = this.tabHits.find(hit => hit.row === event.y && event.x >= hit.start && event.x < hit.end);
      if (hit) { this.changeTab(hit.tab); return {handled:true,render:true}; }
      const hitItem = this.panel.getRenderedItemAt(event.y, event.x);
      const row = hitItem && this.presentation.tabs[this.tab].find(row => row.partition.agent.agent_id === hitItem.id);
      if (hitItem && !hitItem.disabled && row && !row.muted && this.binding.host.snapshot().agents.some(item => item.agent.agent_id === hitItem.id)) {
        this.done({action:"conversation",agentId:hitItem.id}); return {handled:true};
      }
    }
    return this.panel.handleMouse(event);
  }
  handleInput(data: string) {
    if (!this.focused) return; this.update();
    if (matchesKey(data,Key.left) || matchesKey(data,Key.right)) { this.changeTab(this.tab === "running" ? "done" : "running"); return; }
    const id = this.selectedId, row = this.presentation.tabs[this.tab].find(row => row.partition.agent.agent_id === id);
    if (id && row && !row.muted) {
      if (matchesKey(data,Key.enter)) { this.done({action:"conversation",agentId:id}); return; }
      const key = data.toLowerCase();
      const action = key === "x" ? "interrupt" : key === "c" ? "close-agent" : key === "d" ? "delete" : key === "r" && row.partition.agent.lifecycle === "closed" ? "resume" : undefined;
      if (action) { this.done({action,agentId:id}); return; }
    }
    this.panel.handleInput(data);
  }
  private changeTab(tab: AgentTab) {
    if (tab === this.tab) return;
    this.tab = tab; this.selection.tab=tab; this.selection.selectedId=undefined; this.notice = undefined; this.replacing = true; this.panel.dispose(); this.replacing = false; this.makePanel(); this.tui.requestRender();
  }
  private screen(initial?: string) {
    const count = this.presentation.counts, rows = this.presentation.tabs[this.tab], selected = rows.find(row => row.partition.agent.agent_id === this.selectedCached) ?? rows[0];
    return searchSelectScreen({ id:"agents" as const, title:`Subagents · open ${count.open}/${this.binding.config?.capacity.openAgentsPerMain ?? 32}`, breadcrumbs:[], search:false,
      initialSelected: initial, statusLine: `${this.notice ? this.notice + " · " : ""}Enter opens Subagent Pi · X interrupt · C close · D delete${selected?.partition.agent.lifecycle === "closed" ? " · R resume" : ""} · ${layoutSubagentStripV1(count,120)}`,
      choices:this.presentation.tabs[this.tab].map(row => ({ value:row.partition.agent.agent_id, label:row.muted?this.theme.fg("muted",label(row)):label(row), badge:row.muted?undefined:row.labels.map(item=>this.theme.fg(item.tone,item.text)).join(" · "), disabled:row.muted,
        rightText:row.muted?undefined:`${tokens(usage(row))} · ${elapsed(row)}`,
        detail:row.muted?"ancestor":`${row.partition.agent.task_path} · ${row.partition.agent.profile.provider}/${row.partition.agent.profile.model} · effort ${row.partition.agent.profile.reasoning_effort} · ${row.labels.map(item=>item.text).join(" · ")} · ${usage(row)} tokens · ${elapsed(row)}`,tab:this.tab })),
      tabs:{items:[{value:"running",label:"Running",count:count.active},{value:"done",label:"Done",count:count.done}],selected:this.tab,onChange:value=>this.changeTab(value as AgentTab),hint:"Tab/←/→ pages"}, emptyText:"No matching Subagents.", onPick:id=>this.done({action:"conversation",agentId:id}) });
  }
  private selectedCached?: string;
  invalidate() { this.panel.invalidate(); }
  dispose() { clearInterval(this.timer); this.panel.dispose(); }
}

export async function runAgentActionV1(ctx: Pick<ExtensionCommandContext,"ui">, binding: ProcessMainBindingV1, id: string, action: "interrupt" | "close-agent" | "resume" | "delete"): Promise<string> {
  const snapshot = binding.host.snapshot(), item = snapshot.agents.find(item=>item.agent.agent_id===id); if (!item) return "Subagent no longer exists.";
  let result;
  if (action === "interrupt") {
    const task = item.tasks.find(task=>task.task_id===item.agent.current_task_id);
    if (!task?.runtime_generation) return "No current Task to interrupt; queued work is unchanged.";
    result = await binding.host.interruptAgent({request_id:randomUUID(),caller:caller(binding),input:{target:id,expected_task_id:task.task_id,expected_runtime_generation:task.runtime_generation}});
  } else if (action === "resume") {
    result = await binding.host.resumeAgent({request_id:randomUUID(),caller:caller(binding),input:{target:id}});
  } else if (action === "close-agent") {
    const subtree = snapshot.agents.filter(row=>row.agent.task_path===item.agent.task_path||row.agent.task_path.startsWith(`${item.agent.task_path}/`));
    const tasks = subtree.flatMap(row=>row.tasks).filter(task=>task.phase!=="settled").length;
    const busy = tasks>0||subtree.some(row=>row.barrier?.state==="armed");
    if (busy && (await ctx.ui.select(`Force close Subagent\nForce close ${item.agent.task_path}? Cancel ${tasks} Task(s) across ${subtree.length-1} descendant(s).`, ["Cancel", "Force close"])) !== "Force close") return "Cancelled.";
    result = await binding.host.closeAgent({request_id:randomUUID(),caller:caller(binding),input:{target:id,force:busy,expected_lifecycle_revision:item.agent.lifecycle_revision}});
  } else {
    const unread = unreadCompletionsForAgentV1(snapshot,item);
    if (!await ctx.ui.confirm("Delete Subagent",`Delete settled subtree ${item.agent.task_path}?${unread?` ${unread} unread completion(s).`:""}`)) return "Cancelled.";
    const subtree = snapshot.agents.filter(row=>row.agent.task_path===item.agent.task_path||row.agent.task_path.startsWith(`${item.agent.task_path}/`));
    const needsClose = subtree.some(row=>row.agent.lifecycle!=="closed");
    if (needsClose) {
      const closed = await binding.host.closeAgent({request_id:randomUUID(),caller:caller(binding),expected_host_revision:snapshot.root.host_revision,input:{target:id,force:false,expected_lifecycle_revision:item.agent.lifecycle_revision}});
      if (!closed.ok) { ctx.ui.notify(closed.error.message,"error"); return `Failed: ${closed.error.message}`; }
      if (closed.value.lifecycle !== "closed") return "Agent is still closing; retry deletion after cleanup finishes.";
    }
    const current = binding.host.snapshot(), target = current.agents.find(row=>row.agent.agent_id===id);
    if (!target) return "Subagent no longer exists.";
    const currentSubtree = current.agents.filter(row=>row.agent.task_path===target.agent.task_path||row.agent.task_path.startsWith(`${target.agent.task_path}/`));
    if (currentSubtree.some(row=>row.agent.lifecycle!=="closed"||row.tasks.some(task=>task.phase!=="settled")||row.barrier?.state==="armed")) return "Subagent subtree is not closed and settled; retry deletion after cleanup finishes.";
    const currentUnread = unreadCompletionsForAgentV1(current,target);
    if (currentUnread > unread) return "Subagent has new unread completions; review and confirm deletion again.";
    result = await binding.host.deleteSettledSubtree({agentId:target.agent.agent_id,expectedRevision:needsClose?current.root.host_revision:snapshot.root.host_revision,allowUnread:unread>0,at:new Date().toISOString()});
  }
  if (!result.ok) { ctx.ui.notify(result.error.message,"error"); return `Failed: ${result.error.message}`; }
  return action === "resume" ? "Agent restored to open idle." : action === "close-agent" ? `Agent ${(result.value as Record<string,unknown>).lifecycle}.` : action === "delete" ? "Deleted Subagent subtree." : "Interrupt requested.";
}
async function tree(ctx: Pick<ExtensionCommandContext,"ui">,binding:ProcessMainBindingV1,notice?:string,selection?:{tab?:AgentTab;selectedId?:string}) {
  const overlay = createEditorOverlayMount();
  return ctx.ui.custom<SubagentUiResult>((tui,theme,_keys,done)=>overlay.mount(tui,new SubagentManagerV1(tui,theme,binding,done,notice,selection)),overlay.customOptions);
}
export async function showSubagentManagerV1(ctx: Pick<ExtensionCommandContext,"ui">,binding:ProcessMainBindingV1,initialAgentId?:string):Promise<void> {
  if (initialAgentId) { await binding.runtime.openView(initialAgentId as never,binding.terminalOwner!,binding.bindingGeneration); return; }
  let notice: string|undefined; const selection: {tab?:AgentTab;selectedId?:string}={};
  for (;;) {
    const result = await tree(ctx,binding,notice,selection);
    if (result.action === "close" || !result.agentId) return;
    try {
      if (result.action === "conversation") { await binding.runtime.openView(result.agentId as never,binding.terminalOwner!,binding.bindingGeneration); return; }
      notice = await runAgentActionV1(ctx,binding,result.agentId,result.action);
    } catch (error) { notice = safe(error); ctx.ui.notify(notice,"error"); }
  }
}
