import { BranchSummaryMessageComponent, CompactionSummaryMessageComponent, SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

export function installNativeComponentCases(pi, view, log) {
  pi.registerCommand("fixture-summaries", { description: "Compare owned and native expanded Markdown components", handler() {
    const types = { compaction: CompactionSummaryMessageComponent, branch: BranchSummaryMessageComponent, skill: SkillInvocationMessageComponent };
    const create = (name) => {
      const body = `\x60\x60\x60ts\nconst nativeFence = "${view.role}-${name}";\n\x60\x60\x60`;
      const component = name === "skill" ? new types[name]({ name: "native-fixture", content: body })
        : new types[name]({ role: name === "compaction" ? "compactionSummary" : "branchSummary", summary: body, tokensBefore: 100, fromId: "fixture", timestamp: Date.now() });
      component.setExpanded(true); return component;
    };
    // These separate, unattached instances must retain Pi's native markers.
    const native = Object.fromEntries(Object.keys(types).map((name) => [name, create(name).render(100)]));
    const owned = Object.fromEntries(Object.keys(types).map((name) => [name, create(name)]));
    view.ctx.ui.setWidget("fixture-summaries", () => {
      const host = new Container(); for (const component of Object.values(owned)) host.addChild(component); return host;
    });
    const rows = Object.fromEntries(Object.entries(owned).map(([name, component]) => {
      const first = component.render(100); component.invalidate();
      return [name, { first, after: component.render(100) }];
    }));
    log({ event: "native-summaries", role: view.role, native, rows });
  } });
  pi.registerCommand("fixture-clear-summaries", { description: "Release native Markdown fixtures", handler() { view.ctx.ui.setWidget("fixture-summaries", undefined); } });

  // Real renderer lookups + public native mouse dispatch exercise forwarding,
  // including child capture/focus and render:false, without mutating Components.
  for (const method of ["registerEntryRenderer", "registerMessageRenderer"]) {
    pi[method](`fixture-mouse-${method}`, (value) => {
      const state = value.data ?? value.details;
      const component = Object.freeze({ render: () => ["MOUSE_CONTRACT"], invalidate() {}, handleInput() {},
        handleMouse(event) { state.events.push(event.type); return state.result; },
        handleClick(row, column) { state.clicks.push([row, column]); return true; },
      });
      state.component = component; return component;
    });
  }
  pi.registerCommand("fixture-mouse-contract", { description: "Preserve native mouse handling across custom renderer boundaries", handler() {
    const runner = view.session.extensionRunner;
    const records = [];
    for (const kind of ["entry", "message"]) for (const result of [undefined, { handled: true, render: false }, { capture: true }, { focus: true }]) {
      const state = { events: [], clicks: [], result };
      const type = `fixture-mouse-register${kind === "entry" ? "Entry" : "Message"}Renderer`;
      const renderer = kind === "entry" ? runner.getEntryRenderer(type) : runner.getMessageRenderer(type);
      const component = renderer({ customType: type, data: state, details: state }, { expanded: false, outputPad: 0 }, {});
      const host = new Container(); host.addChild(component); host.render(20);
      const event = { type: "click", button: "left", x: 3, y: 0, screenX: 10, screenY: 5, width: 20, height: 1, shift: false, alt: false, ctrl: false };
      const dispatched = host.handleMouse(event);
      const forwarded = !result ? dispatched === undefined : (result.capture ? dispatched?.capture && dispatched.target.component === component
        : result.focus ? dispatched?.focus && dispatched.focusTarget === component
        : dispatched?.handled && dispatched.render === false && dispatched.target.component === component);
      if (!result) for (const type of ["press", "drag", "release", "wheel", "move"])
        records.push({ kind, type, unhandled: host.handleMouse({ ...event, type }) === undefined });
      if (!result) records.push({ kind, type: "right-click", unhandled: host.handleMouse({ ...event, button: "right" }) === undefined });
      records.push({ kind, result, forwarded: !!forwarded, clicks: state.clicks, events: state.events, frozen: Object.isFrozen(state.component) });
    }
    log({ event: "mouse-contract", role: view.role, records });
  } });
}
