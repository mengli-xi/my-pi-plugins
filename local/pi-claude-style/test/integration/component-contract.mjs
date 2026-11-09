import assert from "node:assert/strict";
import { Container, VStack, isFocusable } from "@earendil-works/pi-tui";
import { createCustomEntryDelegate } from "../../../pi-processes/src/integrations/custom-entry-delegate.ts";
import { installAccessorContract } from "./accessor-contract.mjs";

// Public tree only. A transparent facade has no synthetic children array.
export function findRendered(root, token, width) {
  for (const child of root.children ?? []) {
    const nested = findRendered(child, token, width);
    if (nested) return nested;
    if (child.render(width).some((line) => line.includes(token))) return child;
  }
}

const methodKeys = ["handleInput", "handleMouse", "dispose", "setScreenOrigin", "setAvailableHeight", "getText", "setText", "onSubmit", "onChange", "addToHistory", "insertTextAtCursor", "getExpandedText", "setAutocompleteProvider", "borderColor", "setPaddingX", "setAutocompleteMaxVisible"];
const propertyKeys = ["focused", "wantsKeyRelease", "children"];
const extraSymbol = Symbol("component-owned-protocol");
function candidate(label, shape = "full") {
  const state = { focused: false, wantsKeyRelease: false, calls: [] };
  class Candidate {
    #state = state;
    render(width) { this.#state.calls.push(["render", width]); return [label + " focused=" + this.#state.focused]; }
    invalidate() { this.#state.calls.push(["invalidate"]); }
    record(key, args) { this.#state.calls.push([key, ...args]); return key === "handleMouse" ? { focus: true, render: false } : key + ":ok"; }
    getState() { return this.#state; }
  }
  if (shape === "full") {
    for (const key of [...methodKeys, extraSymbol]) Object.defineProperty(Candidate.prototype, key, {
      value: function (...args) { return this.record(typeof key === "symbol" ? "symbol" : key, args); }, configurable: true,
    });
    for (const key of ["focused", "wantsKeyRelease"]) Object.defineProperty(Candidate.prototype, key, {
      get() { return this.getState()[key]; }, set(value) { this.getState()[key] = value; }, configurable: true,
    });
    Object.defineProperty(Candidate.prototype, "children", { get: () => [], configurable: true });
  } else if (shape === "undefined") {
    for (const key of [...methodKeys, ...propertyKeys, extraSymbol]) Object.defineProperty(Candidate.prototype, key, { value: undefined });
  }
  return { component: Object.freeze(new Candidate()), state };
}

export function installComponentContract(pi, view, log) {
  installAccessorContract(pi, view, log);
  const callbacks = {};
  for (const kind of ["entry", "message"]) {
    const callback = (value) => (value.data ?? value.details).component;
    callbacks[kind] = callback;
    pi[kind === "entry" ? "registerEntryRenderer" : "registerMessageRenderer"](`fixture-contract-${kind}`, callback);
  }
  const lookup = (kind) => view.session.extensionRunner[kind === "entry" ? "getEntryRenderer" : "getMessageRenderer"](`fixture-contract-${kind}`);
  pi.registerCommand("fixture-component-contract", { description: "Compare native and CC Component protocols", handler() {
    const records = [];
    for (const kind of ["entry", "message"]) for (const shape of ["full", "bare", "undefined"]) {
      const native = candidate("CONTRACT", shape), cc = candidate("CONTRACT", shape);
      const raw = callbacks[kind]({ data: native, details: native });
      const facade = lookup(kind)({ data: cc, details: cc });
      const keys = ["render", "invalidate", ...methodKeys, ...propertyKeys, extraSymbol];
      for (const key of keys) {
        assert.equal(key in facade, key in raw, `${kind}/${shape}/${String(key)} presence`);
        assert.equal(Object.hasOwn(facade, key), Object.hasOwn(raw, key), `${kind}/${shape}/${String(key)} own presence`);
        if (typeof raw[key] === "function") {
          const args = key === "render" ? [80] : key === "handleMouse" ? [{ type: "click", button: "left" }] : key === "invalidate" ? [] : [7, 9];
          assert.deepEqual(facade[key](...args), raw[key](...args), `${kind}/${shape}/${String(key)} result`);
          assert.equal(facade[key], facade[key], "stable method identity");
        } else assert.deepEqual(facade[key], raw[key]);
      }
      if (shape === "full") for (const key of ["focused", "wantsKeyRelease"]) {
        facade[key] = raw[key] = true;
        assert.equal(cc.state[key], native.state[key]); assert.equal(facade[key], raw[key]);
        cc.component[key] = native.component[key] = false;
        assert.equal(facade[key], raw[key]);
      }
      assert.deepEqual(cc.state.calls, native.state.calls, `${kind}/${shape} receiver and calls`);
      assert.equal(isFocusable(facade), isFocusable(raw));
      assert.equal(facade instanceof cc.component.constructor, true);
      // Same temporary decoration/descriptor restore as Pinned's frame hook.
      const before = facade.render(80); const original = facade.render;
      const descriptor = Object.getOwnPropertyDescriptor(facade, "render");
      let decorated = 0;
      facade.render = function (width) { decorated++; return original.call(this, width); };
      assert.deepEqual(facade.render(80), before); assert.equal(decorated, 1);
      if (descriptor) Object.defineProperty(facade, "render", descriptor); else delete facade.render;
      assert.deepEqual(facade.render(80), before); assert.equal(decorated, 1);
      assert.equal(Object.hasOwn(facade, "render"), Object.hasOwn(cc.component, "render"));
      records.push({ kind, shape, members: keys.map(String), equivalent: true, frozenSource: Object.isFrozen(cc.component) });
    }
    // Exported VStack exercises Pi's actual symbol layout protocol without a
    // deep import or a production dependency on the non-root-exported symbol.
    for (const kind of ["entry", "message"]) {
      const stack = new VStack([{ render: () => ["STACK_CONTRACT"], invalidate() {} }]);
      const facade = lookup(kind)({ data: { component: stack }, details: { component: stack } });
      for (let prototype = stack; prototype; prototype = Object.getPrototypeOf(prototype)) for (const key of Object.getOwnPropertySymbols(prototype)) {
        assert.equal(key in facade, true);
        if (typeof stack[key] === "function") assert.deepEqual(facade[key](), stack[key]());
      }
      assert.deepEqual(facade.render(30), stack.render(30));
      assert.equal(facade.children, stack.children);
      records.push({ kind, shape: "native-stack", equivalent: true });
      // Regular mode's handleClick is no longer bridged: Pi fullscreen only calls handleMouse.
      let clicked = 0;
      const clickOnly = Object.freeze({ render: () => ["CLICK_ONLY_CONTRACT"], invalidate() {}, handleClick() { clicked++; return true; } });
      const clickOnlyFacade = lookup(kind)({ data: { component: clickOnly }, details: { component: clickOnly } });
      assert.equal("handleMouse" in clickOnlyFacade, false); assert.equal("handleInput" in clickOnlyFacade, false);
      const host = new Container(); host.addChild(clickOnlyFacade); host.render(30);
      const result = host.handleMouse({ type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 30, height: 1, shift: false, alt: false, ctrl: false });
      assert.equal(result, undefined); assert.equal(clicked, 0);
      records.push({ kind, shape: "click-only", equivalent: true, noBridge: true });
    }
    log({ event: "component-contract", role: view.role, records });
  } });

  for (const kind of ["entry", "message"]) {
    pi.registerCommand(`fixture-focus-${kind}`, { description: `Compare real ${kind} renderer mouse focus and input`, handler() {
      const sequence = view.focusSequence = (view.focusSequence ?? 0) + 1;
      const token = `${view.role.toUpperCase()}_${kind.toUpperCase()}_${sequence}`;
      const create = (name) => {
        const state = { focused: false, text: "" };
        class FocusCase {
          #state = state;
          get focused() { return this.#state.focused; } set focused(value) { this.#state.focused = value; }
          render() { return [`FOCUS_${name}_${token} focused=${this.#state.focused} input=${this.#state.text}`]; }
          invalidate() {}
          handleInput(data) { if (this.#state.focused) this.#state.text += data; }
          handleMouse(event) { return event.type === "click" && event.button === "left" ? { focus: true } : undefined; }
        }
        return { component: Object.freeze(new FocusCase()), state };
      };
      const native = create("NATIVE"), cc = create("CC");
      view.ctx.ui.setWidget("fixture-focus-control", () => native.component);
      if (kind === "entry") pi.appendEntry(`fixture-contract-${kind}`, cc);
      else pi.sendMessage({ customType: `fixture-contract-${kind}`, content: "focus fixture", details: cc, display: true });
      view.focusCase = { native, cc, token, kind };
      log({ event: "focus-case", role: view.role, kind, token });
    } });
    // A frozen consumer row that forwards Pi's mouse to a real v1 delegate.
    pi[kind === "entry" ? "registerEntryRenderer" : "registerMessageRenderer"](`fixture-delegate-${kind}`, (value, options, theme) => {
      const { token } = value.data ?? value.details;
      const delegate = createCustomEntryDelegate("ctx-status", { version: 1, customType: "ctx-status", data: { level: "warning" },
        presentation: { title: "delegate", summary: token, heading: "delegate body", body: `DELEGATE_BODY_${token}` }, options, theme,
      }, { render: () => [token], invalidate() {} });
      return Object.freeze({ render: (width) => delegate.render(width), invalidate: () => delegate.invalidate(), handleMouse(event) {
        if (event.type === "click") log({ event: "delegate-row-click", role: view.role, kind, focusWasFacade: view.tui.getFocusedComponent() === view.delegateFacade });
        return delegate.handleMouse(event);
      } });
    });
    pi.registerCommand(`fixture-delegate-${kind}`, { description: `Click a ${kind} renderer through a v1 presentation delegate`, handler() {
      const token = `DELEGATE_${view.role.toUpperCase()}_${kind.toUpperCase()}_${view.delegateSequence = (view.delegateSequence ?? 0) + 1}`;
      if (kind === "entry") pi.appendEntry(`fixture-delegate-${kind}`, { token });
      else pi.sendMessage({ customType: `fixture-delegate-${kind}`, content: "delegate fixture", details: { token }, display: true });
      view.delegateFacade = findRendered(view.tui, token, view.tui.terminal.columns);
      assert.ok(view.delegateFacade); assert.equal("handleInput" in view.delegateFacade, false);
      assert.equal("handleMouse" in view.delegateFacade, true);
      log({ event: "delegate-row", role: view.role, kind, token, noInput: true });
    } });
  }
  pi.registerShortcut("alt+v", { description: "Inspect real focused states and keyboard delivery", handler() {
    const { native, cc, token, kind } = view.focusCase;
    log({ event: "focus-state", role: view.role, token, kind, native: native.state, cc: cc.state });
  } });
  pi.registerCommand("fixture-clear-focus", { description: "Release the native focus control", handler() { view.ctx.ui.setWidget("fixture-focus-control", undefined); } });
}
