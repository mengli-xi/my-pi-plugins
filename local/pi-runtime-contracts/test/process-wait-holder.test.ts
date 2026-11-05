import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function check(version: number, body: string): void {
  const module = new URL(`../src/process-wait-bridge-v${version}.ts`, import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    const api = await import(${JSON.stringify(module)});
    const key = Symbol.for('pi.subagents.process-wait-bridge.v${version}');
    const get = api.getProcessWaitBridgeV${version};
    const register = api.registerProcessWaitBridgeV${version};
    const bridge = { version: ${version}, sessionId: 'holder-test',
      beforeContinuation: async () => {}, captureOwnerToken: () => 'owner',
      admitContinuation: async () => 'record-only' };
    const incompatible = /incompatible Process wait bridge v${version} holder/;
    ${body}
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

for (const version of [1, 2]) {
  for (const value of ["undefined", "null", "false", "7", "'invalid'", "[]", "{}", "{ bySession: [] }", "{ bySession: {} }"]) {
    test(`Process wait v${version} rejects existing ${value} without replacement`, () => {
      check(version, `
        const value = ${value};
        Object.defineProperty(globalThis, key, { value, configurable: false });
        const before = Object.getOwnPropertyDescriptor(globalThis, key);
        assert.throws(() => get(bridge.sessionId), incompatible);
        assert.throws(() => register(bridge), incompatible);
        assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), before);
      `);
    });
  }

  test(`Process wait v${version} does not invoke a global holder getter`, () => {
    check(version, `
      let calls = 0;
      const getter = () => { calls++; return { bySession: new Map() }; };
      Object.defineProperty(globalThis, key, { get: getter, configurable: false });
      assert.throws(() => get(bridge.sessionId), incompatible);
      assert.throws(() => register(bridge), incompatible);
      assert.equal(calls, 0);
      assert.equal(Object.getOwnPropertyDescriptor(globalThis, key).get, getter);
    `);
  });

  test(`Process wait v${version} does not invoke a bySession getter`, () => {
    check(version, `
      let calls = 0;
      const value = Object.freeze({ get bySession() { calls++; return new Map(); } });
      Object.defineProperty(globalThis, key, { value, configurable: false });
      assert.throws(() => get(bridge.sessionId), incompatible);
      assert.throws(() => register(bridge), incompatible);
      assert.equal(calls, 0);
      assert.equal(globalThis[key], value);
    `);
  });

  test(`Process wait v${version} rejects an inherited session map`, () => {
    check(version, `
      const value = Object.create({ bySession: new Map() });
      Object.defineProperty(globalThis, key, { value });
      assert.throws(() => get(bridge.sessionId), incompatible);
      assert.throws(() => register(bridge), incompatible);
      assert.equal(globalThis[key], value);
    `);
  });

  test(`Process wait v${version} creates one holder and preserves duplicate/disposal behavior`, () => {
    check(version, `
      assert.equal(Object.getOwnPropertyDescriptor(globalThis, key), undefined);
      assert.equal(get(bridge.sessionId), undefined);
      const holder = globalThis[key];
      assert(Object.isFrozen(holder));
      assert(holder.bySession instanceof Map);
      const first = register(bridge);
      assert.equal(get(bridge.sessionId), bridge);
      assert.throws(() => register(bridge), /already registered/);
      first.dispose();
      assert.equal(get(bridge.sessionId), undefined);
      const replacement = { ...bridge };
      const second = register(replacement);
      first.dispose();
      assert.equal(get(bridge.sessionId), replacement);
      assert.equal(globalThis[key], holder);
      second.dispose();
      assert.equal(get(bridge.sessionId), undefined);
    `);
  });

  for (const frozen of [false, true]) {
    test(`Process wait v${version} reuses a valid existing ${frozen ? "frozen" : "mutable"} holder`, () => {
      check(version, `
        const bySession = new Map([[bridge.sessionId, bridge]]);
        const holder = ${frozen ? "Object.freeze({ bySession })" : "{ bySession }"};
        Object.defineProperty(globalThis, key, { value: holder, configurable: false });
        assert.equal(get(bridge.sessionId), bridge);
        assert.throws(() => register(bridge), /already registered/);
        const extra = { ...bridge, sessionId: 'second-session' };
        const handle = register(extra);
        assert.equal(bySession.get(extra.sessionId), extra);
        handle.dispose();
        assert.equal(bySession.has(extra.sessionId), false);
        assert.equal(bySession.get(bridge.sessionId), bridge);
        assert.equal(globalThis[key], holder);
      `);
    });
  }
}
