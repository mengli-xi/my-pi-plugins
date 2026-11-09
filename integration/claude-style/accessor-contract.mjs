import assert from "node:assert/strict";

function accessor(label, frozen) {
  const state = { setterCalls: 0 };
  class Accessor {
    #version = 1;
    #render = this.nextRender();
    nextRender() { const version = this.#version; return (width) => [`${label} v${version} width=${width}`]; }
    get render() { return this.#render; }
    set render(value) {
      state.setterCalls++;
      Object.defineProperty(this, "render", { value, configurable: true, enumerable: true, writable: true });
    }
    advance() { this.#version++; this.#render = this.nextRender(); }
    invalidate() {}
  }
  const component = new Accessor();
  Object.defineProperty(component, "render", { ...Object.getOwnPropertyDescriptor(Accessor.prototype, "render"), enumerable: true });
  if (frozen) Object.freeze(component);
  return { component, state, descriptor: Object.getOwnPropertyDescriptor(component, "render") };
}

function decorate(component) {
  const original = component.render;
  const descriptor = Object.getOwnPropertyDescriptor(component, "render");
  let decorated = 0;
  component.render = function (width) { decorated++; return original.call(this, width); };
  const during = component.render(80);
  if (descriptor) Object.defineProperty(component, "render", descriptor); else delete component.render;
  const after = component.render(80);
  assert.equal(decorated, 1, "restored accessor must not retain temporary decoration");
  assert.deepEqual(after, during);
  return { decorated, after };
}

export function installAccessorContract(pi, view, log) {
  const rendered = new Map();
  const renderer = (value) => {
    const data = value.data ?? value.details;
    if (!data.accessorFixture) return data.component;
    const item = accessor(data.token, data.frozen); rendered.set(data.token, item); return item.component;
  };
  for (const kind of ["entry", "message"]) pi[kind === "entry" ? "registerEntryRenderer" : "registerMessageRenderer"](`fixture-accessor-${kind}`, renderer);
  const lookup = (kind) => view.session.extensionRunner[kind === "entry" ? "getEntryRenderer" : "getMessageRenderer"](`fixture-accessor-${kind}`);
  pi.registerCommand("fixture-accessor-contract", { description: "Restore data and accessor render slots without writing the source", handler() {
    const records = [];
    for (const kind of ["entry", "message"]) for (const frozen of [true, false]) {
      const native = accessor("ACCESSOR_CONTRACT", frozen), cc = accessor("ACCESSOR_CONTRACT", frozen);
      const facade = lookup(kind)({ data: cc, details: cc });
      assert.deepEqual(facade.render(80), native.component.render(80));
      for (let cycle = 0; cycle < 3; cycle++) {
        const actual = decorate(facade);
        if (!frozen) assert.deepEqual(actual, decorate(native.component));
        assert.deepEqual(Object.getOwnPropertyDescriptor(cc.component, "render"), cc.descriptor);
        assert.deepEqual(Object.getOwnPropertyDescriptor(native.component, "render"), native.descriptor);
        assert.equal(cc.state.setterCalls, 0);
      }
      const base = Object.getOwnPropertyDescriptor(facade, "render");
      let localSetter;
      Object.defineProperty(facade, "render", { configurable: true, enumerable: false,
        get() { return (width) => [`LOCAL_SLOT width=${width}`]; }, set(value) { localSetter = value; },
      });
      assert.deepEqual(facade.render(80), ["LOCAL_SLOT width=80"]);
      Object.getOwnPropertyDescriptor(facade, "render").set("local"); assert.equal(localSetter, "local");
      Object.defineProperty(facade, "render", { configurable: true, writable: true, value: () => ["DATA_SLOT"] });
      assert.deepEqual(facade.render(80), ["DATA_SLOT"]);
      delete facade.render;
      assert.equal(Object.getOwnPropertyDescriptor(facade, "render"), undefined);
      cc.component.advance(); native.component.advance();
      assert.deepEqual(facade.render(80), native.component.render(80), "deleted slot must read the source's current getter value");
      Object.defineProperty(facade, "render", base);
      assert.deepEqual(facade.render(80), native.component.render(80), "restored default getter must read the source, not the override");
      decorate(facade);
      assert.deepEqual(Object.getOwnPropertyDescriptor(cc.component, "render"), cc.descriptor);
      assert.equal(cc.state.setterCalls, 0);
      records.push({ kind, frozen, decoratedOnce: true, sourceUnchanged: true, currentGetter: true });
    }
    log({ event: "accessor-contract", role: view.role, records });
  } });
  pi.registerCommand("fixture-accessor-rows", { description: "Use real CC fullscreen frames for frozen and mutable accessor renderers", handler() {
    const sequence = view.accessorSequence = (view.accessorSequence ?? 0) + 1;
    const cases = [];
    for (const kind of ["entry", "message"]) for (const frozen of [true, false]) {
      const token = `ACCESSOR_ROW_${view.role.toUpperCase()}_${kind.toUpperCase()}_${frozen ? "FROZEN" : "MUTABLE"}_${sequence}`;
      // Session data must remain cloneable: the real renderer creates the
      // component and keeps its getter/descriptor outside the persisted entry.
      const value = { accessorFixture: true, token, frozen }; cases.push({ token, kind, frozen });
      if (kind === "entry") pi.appendEntry(`fixture-accessor-${kind}`, value);
      else pi.sendMessage({ customType: `fixture-accessor-${kind}`, content: token, details: value, display: true });
    }
    view.accessorCases = cases;
    log({ event: "accessor-rows", role: view.role, tokens: cases.map((item) => item.token) });
  } });
  pi.registerCommand("fixture-accessor-verify", { description: "Verify original accessor descriptors after actual CC fullscreen frame restoration", handler() {
    for (const item of view.accessorCases) {
      const actual = rendered.get(item.token);
      assert.deepEqual(Object.getOwnPropertyDescriptor(actual.component, "render"), actual.descriptor);
      assert.equal(actual.state.setterCalls, 0);
      assert.equal(Object.isFrozen(actual.component), item.frozen);
    }
    log({ event: "accessor-frame", role: view.role, sourcesUnchanged: true, count: view.accessorCases.length });
  } });
}
