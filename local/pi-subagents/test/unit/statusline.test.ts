import assert from "node:assert/strict";
import test from "node:test";
import { SubagentStatuslinePublisherV1 } from "../../src/ui/statusline.ts";

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("Subagents publishes a clickable total Agent count on statusline row three and withdraws it", async () => {
  const agents: unknown[] = [];
  const emitted: Array<{ channel: string; payload: any }> = [];
  let opened = 0;
  const pi = { events: { emit(channel: string, payload: any) { emitted.push({ channel, payload }); payload.reply?.(true); } } };
  const ctx = { ui: { theme: { fg: (_color: string, text: string) => text } } };
  const binding = { runtime:{residency:()=>undefined},host: { host_revision:1, snapshot: () => ({root:{host_revision:1,inbox:[]}, agents }) } };
  const publisher = new SubagentStatuslinePublisherV1(pi as never, ctx as never, binding as never, () => { opened++; });
  try {
    assert.equal(emitted[0]?.channel, "statusline:row");
    assert.deepEqual({ ...emitted[0]?.payload, reply: undefined, onClick: undefined }, { key: "subagents", placement: "inline", row: 3, align: "left", reply: undefined, onClick: undefined });
    agents.push({agent:{agent_id:"a",lifecycle:"open",availability:"available",queued_task_ids:[],created_at:new Date().toISOString()},tasks:[],completions:[],inbox:[]});
    publisher.publish();
    const active = emitted.at(-1)!.payload;
    assert.equal(active.line, "agents 1");
    assert.equal(active.onClick(), true);
    assert.equal(opened, 1);
    const count = emitted.length;
    publisher.publish();
    assert.equal(emitted.length, count);
  } finally { publisher.dispose(); }
  await wait();
  assert.equal(emitted.at(-1)?.payload.key, "subagents");
  assert.equal(emitted.at(-1)?.payload.line, undefined);
});

test("a stale public Pi API retires late statusline ticks without crashing or retrying", () => {
  let stale = false, calls = 0;
  const pi = { events: { emit() { calls++; if (stale) throw new Error("extension ctx is stale"); } } };
  const publisher = new SubagentStatuslinePublisherV1(pi as never, {} as never, (() => undefined) as never, () => {});
  stale = true;
  assert.doesNotThrow(() => publisher.publish());
  const retired = calls;
  publisher.publish(); publisher.dispose();
  assert.equal(calls, retired);
});

test("same total with state/unread/revision change republishes complete tuple",()=>{
 let revision=1;const item:any={agent:{agent_id:"a",lifecycle:"open",availability:"available",queued_task_ids:[],created_at:new Date().toISOString()},tasks:[{task_id:"t",phase:"running",admission_order:1}],completions:[],inbox:[]};
 const emitted:any[]=[],pi:any={events:{emit:(_c:any,p:any)=>{emitted.push(p);p.reply?.();}}},binding:any={runtime:{residency:()=>undefined},host:{get host_revision(){return revision;},snapshot:()=>({root:{host_revision:revision,inbox:[]},agents:[item]})}},ctx:any={ui:{theme:{fg:(_c:string,s:string)=>s}}};
 const p=new SubagentStatuslinePublisherV1(pi,ctx,binding,()=>{});
 try{assert.match(emitted.at(-1).line,/running 1/);item.tasks[0].phase="settled";revision++;p.publish();assert.equal(emitted.at(-1).line,"agents 1");item.inbox=[{inbox_id:"inb",completion_id:"cmp",recipient:{agent_id:"a"},state:"appended"}];p.publish();assert.match(emitted.at(-1).line,/unread 1/);}finally{p.dispose();}
});
