import assert from "node:assert/strict";
import test from "node:test";
import { registerSubagentMessageRenderersV1 } from "../../src/ui/completion-renderer.ts";

const LEFT_CLICK = { type: "click", button: "left", x: 0, y: 0, width: 120, height: 1, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false } as const;

const theme = { fg: (_color: string, value: string) => value } as never;

test("Completion renderer stays on one line and delegates its full result to CC Style", () => {
  let renderer: any;
  registerSubagentMessageRenderersV1({ registerMessageRenderer(type: string, value: unknown) { if (type === "subagent-completion-v1") renderer = value; } } as never);
  const details = {
    version: 1,
    details_json: JSON.stringify({
      completion: { outcome: "completed", reason: "normal-final", summary: "Reviewed the implementation" },
      task_path: "/root/review",
      usage: { total_tokens: 1234 },
      task_started_at: "2026-08-23T10:00:00.000Z",
      completed_at: "2026-08-23T10:00:05.000Z",
      result_truncated: false,
      original_result_bytes: 26,
      rendered_result_bytes: 26,
    }),
  };
  const content = '<subagent_completion version="1" task_path="/root/review" outcome="completed" reason="normal-final"><summary>Reviewed the implementation</summary><result>SECRET FULL EXECUTION BODY</result></subagent_completion>';
  const globals = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("pi.claude-style.custom-entry-presentations.v1");
  delete globals[key];

  const fallback = renderer({ content, details }, { expanded: true, outputPad: 0 }, theme);
  const fallbackRows = fallback.render(120);
  assert.equal(fallbackRows.length, 1);
  assert.match(fallbackRows[0]!, /Agent '\/root\/review'/);
  assert.match(fallbackRows[0]!, /1\.2k tokens/);
  assert.match(fallbackRows[0]!, /5s/);
  assert.doesNotMatch(fallbackRows[0]!, /Reviewed the implementation|SECRET FULL EXECUTION BODY/);
  assert.equal(fallback.handleMouse(LEFT_CLICK), undefined);

  let request: any;
  globals[key] = {
    version: 1,
    providers: new Map([["subagent-completion-v1", {
      version: 1,
      render(value: unknown) {
        request = value;
        return { render: () => ["delegated"], invalidate() {}, handleMouse: () => ({ handled: true }) };
      },
    }]]),
  };
  assert.deepEqual(fallback.render(120), ["delegated"]);
  assert.equal(fallback.handleMouse(LEFT_CLICK)?.handled, true);
  assert.equal(request.completion.summary, "Reviewed the implementation");
  assert.equal(request.completion.result, "SECRET FULL EXECUTION BODY");
  delete globals[key];
});

test("Completion retries the same temporarily unavailable provider without losing its real click", () => {
  let renderer: any, ready = false, calls = 0, read = 0;
  registerSubagentMessageRenderersV1({ registerMessageRenderer(type: string, value: unknown) { if (type === "subagent-completion-v1") renderer = value; } } as never, () => { read++; });
  const globals = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("pi.claude-style.custom-entry-presentations.v1");
  globals[key] = { version: 1, providers: new Map([["subagent-completion-v1", { version: 1, render() {
    calls++;
    return ready ? { render: () => ["ready"], invalidate() {}, handleMouse: (event: typeof LEFT_CLICK) => event.type === "click" ? { handled: true } : undefined } : undefined;
  } }]]) };
  try {
    const component = renderer({ content: "body", details: {} }, { outputPad: 0 }, theme);
    assert.notDeepEqual(component.render(80), ["ready"]);
    ready = true;
    assert.deepEqual(component.render(80), ["ready"]);
    assert.equal(component.handleMouse(LEFT_CLICK)?.handled, true);
    assert.equal(read, 1);
    component.render(80);
    assert.equal(calls, 2, "cache the ready component, not a temporary unavailable result");
  } finally { delete globals[key]; }
});

test("Mailbox renderer shows collapsible summary", () => {
  let renderer: any;
  registerSubagentMessageRenderersV1({ registerMessageRenderer(type: string, value: unknown) { if (type === "subagent-mailbox-v1") renderer = value; } } as never);
  const content = "Line one\nLine two\nLine three";
  for (const expanded of [false, true]) {
    const component = renderer({ content, details: undefined }, { expanded, outputPad: 0 }, theme);
    const rendered = component.render(120).join("\n");
    assert.match(rendered, /Line one/);
    if (expanded) {
      assert.match(rendered, /Line two/);
      assert.match(rendered, /Line three/);
    } else {
      assert.doesNotMatch(rendered, /Line two/);
    }
  }
});

test("layout measurement never reads a card; a successful native opener reads that exact card",()=>{
 let renderer:any,read=0;const details={inbox_id:"inb",completion_id:"cmp"};
 registerSubagentMessageRenderersV1({registerMessageRenderer:(type:string,r:any)=>{if(type==="subagent-completion-v1")renderer=r;}} as any,(actual,body)=>{assert.equal(actual,details);assert.equal(body,"body");read++;});
 const globals=globalThis as any,key=Symbol.for("pi.claude-style.custom-entry-presentations.v1");globals[key]={version:1,providers:new Map([["subagent-completion-v1",{version:1,render:()=>({render:()=>["card"],handleMouse:()=>({handled:true}),invalidate(){}})}]])};
 try{const component=renderer({content:"body",details},{outputPad:0},theme);component.render(80);component.render(20);assert.equal(read,0);component.handleMouse({...LEFT_CLICK,type:"press"});assert.equal(read,0,"a press does not open the card");assert.equal(component.handleMouse(LEFT_CLICK)?.handled,true);assert.equal(read,1);}finally{delete globals[key];}
});
