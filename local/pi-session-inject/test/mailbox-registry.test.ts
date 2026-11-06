import assert from "node:assert/strict";
import { test } from "node:test";
import { MAILBOX_ABI_VERSION, MAILBOX_TRANSPORT_BUILD_ID } from "../src/mailbox-v1/constants.js";
import { checkEngineHolder, loadedEngine, loadEngine } from "../src/mailbox-v1/engine-loader.js";
import { getOrCreateRegistry, readRegistry } from "../src/mailbox-v1/registry.js";

function restore(target: object, key: symbol, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

test("absent registry creates one writable configurable own data property", () => {
  const key = Symbol("absent mailbox registry");
  const value = { version: 1 };
  let creates = 0;
  try {
    assert.equal(readRegistry(key), undefined);
    assert.equal(getOrCreateRegistry(key, () => { creates++; return value; }), value);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), { value, writable: true, configurable: true, enumerable: true });
    assert.equal(getOrCreateRegistry(key, () => { creates++; return {}; }), value);
    assert.equal(readRegistry(key), value);
    assert.equal(creates, 1);
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});

for (const value of [{ version: 1 }, null, false, 0]) {
  test(`existing registry ${JSON.stringify(value)} retains its descriptor and identity`, () => {
    const key = Symbol("existing mailbox registry");
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: false, enumerable: false });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    try {
      assert.equal(readRegistry(key), value);
      assert.equal(getOrCreateRegistry(key, () => { throw new Error("must not create"); }), value);
      assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor);
    } finally {
      Reflect.deleteProperty(globalThis, key);
    }
  });
}

for (const location of ["own", "inherited"] as const) {
  for (const kind of ["undefined", "accessor", "setter-only", "data"] as const) {
    if (location === "own" && kind === "data") continue;
    test(`${location} registry ${kind} fails closed without user code or descriptor changes`, () => {
      const key = Symbol("incompatible mailbox registry");
      const target = location === "own" ? globalThis : Object.prototype;
      let gets = 0, sets = 0, creates = 0;
      const descriptor = kind === "undefined" ? { value: undefined, writable: true, configurable: true } :
        kind === "data" ? { value: { version: 1 }, writable: true, configurable: true } :
        kind === "setter-only" ? { set: () => { sets++; }, configurable: true } :
        { get: () => { gets++; return undefined; }, set: () => { sets++; }, configurable: true };
      Object.defineProperty(target, key, descriptor);
      const original = Object.getOwnPropertyDescriptor(target, key);
      try {
        assert.throws(() => readRegistry(key), { code: "holder-incompatible" });
        assert.throws(() => getOrCreateRegistry(key, () => { creates++; return {}; }), { code: "holder-incompatible" });
        assert.equal(gets, 0);
        assert.equal(sets, 0);
        assert.equal(creates, 0);
        assert.deepEqual(Object.getOwnPropertyDescriptor(target, key), original);
        if (location === "inherited") assert.equal(Object.hasOwn(globalThis, key), false);
      } finally {
        Reflect.deleteProperty(target, key);
      }
    });
  }
}

const engineKey = Symbol.for("pi.session-inject.mailbox.engine.v1");
function emptyEngineHolder() {
  return { version: MAILBOX_ABI_VERSION, transportBuildId: MAILBOX_TRANSPORT_BUILD_ID, namespace: null, loading: null };
}

test("engine loader creates and reuses a compatible holder without changing its descriptor", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, engineKey);
  try {
    Reflect.deleteProperty(globalThis, engineKey);
    checkEngineHolder();
    const created = readRegistry(engineKey);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, engineKey);
    assert.deepEqual(created, emptyEngineHolder());
    assert.equal(descriptor?.writable, true);
    assert.equal(descriptor?.configurable, true);
    assert.equal(loadedEngine(), null);
    checkEngineHolder();
    assert.equal(readRegistry(engineKey), created);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, engineKey), descriptor);
  } finally {
    restore(globalThis, engineKey, previous);
  }
});

test("engine loader still rejects incompatible ABI/build/namespace/loading holders without replacement", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, engineKey);
  try {
    for (const value of [
      { ...emptyEngineHolder(), version: 999 },
      { ...emptyEngineHolder(), transportBuildId: "foreign-build" },
      { ...emptyEngineHolder(), namespace: {} },
      { ...emptyEngineHolder(), loading: {} },
    ]) {
      Object.defineProperty(globalThis, engineKey, { value, configurable: true, writable: false, enumerable: false });
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, engineKey);
      assert.throws(() => checkEngineHolder(), { code: "holder-incompatible" });
      assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, engineKey), descriptor);
    }
  } finally {
    restore(globalThis, engineKey, previous);
  }
});

for (const location of ["own", "inherited"] as const) {
  for (const kind of ["undefined", "accessor"] as const) {
    test(`engine loader rejects ${location} ${kind} registry before holder access`, () => {
      const previous = Object.getOwnPropertyDescriptor(globalThis, engineKey);
      const inherited = Object.getOwnPropertyDescriptor(Object.prototype, engineKey);
      const target = location === "own" ? globalThis : Object.prototype;
      let gets = 0, sets = 0;
      try {
        Reflect.deleteProperty(globalThis, engineKey);
        Object.defineProperty(target, engineKey, kind === "undefined" ? { value: undefined, writable: true, configurable: true } : {
          get: () => { gets++; return emptyEngineHolder(); }, set: () => { sets++; }, configurable: true,
        });
        const descriptor = Object.getOwnPropertyDescriptor(target, engineKey);
        assert.throws(() => checkEngineHolder(), { code: "holder-incompatible" });
        assert.throws(() => loadedEngine(), { code: "holder-incompatible" });
        assert.throws(() => loadEngine(), { code: "holder-incompatible" });
        assert.equal(gets, 0);
        assert.equal(sets, 0);
        assert.deepEqual(Object.getOwnPropertyDescriptor(target, engineKey), descriptor);
        if (location === "inherited") assert.equal(Object.hasOwn(globalThis, engineKey), false);
      } finally {
        restore(Object.prototype, engineKey, inherited);
        restore(globalThis, engineKey, previous);
      }
    });
  }
}
