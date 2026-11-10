import { registerHooks } from "node:module";

// Node's synchronous hooks cover createRequire(), unlike async loaders and
// Vitest's ESM mocks. Register before dynamically importing the auth modules.
// https://nodejs.org/docs/latest-v24.x/api/module.html#synchronous-customization-hooks
export function installAuthBackend() {
  const entries = new Map<string, string>();
  const operations: { operation: string; service: string; account: string }[] = [];
  let mode = "memory";
  const key = (service: string, account: string) => `${service}\0${account}`;
  function check(operation: string, payload?: string) {
    if (mode === "unavailable") throw new Error("simulated secure credential store unavailable");
    if (mode === "keyrevoked") throw new Error("Couldn't access platform storage: KeyRevoked", { cause: new Error("KeyRevoked") });
    if (mode === "writefailing" && operation === "write") throw new Error("simulated secure credential store write failure");
    if (mode === "sizelimited" && operation === "write" && payload!.length > 1280) throw new Error("secure credential value exceeds platform limit");
  }
  class Entry {
    service: string;
    account: string;
    constructor(service: string, account: string) { this.service = service; this.account = account; }
    getPassword() {
      operations.push({ operation: "read", service: this.service, account: this.account });
      check("read");
      return entries.get(key(this.service, this.account)) ?? null;
    }
    setPassword(payload: string) {
      operations.push({ operation: "write", service: this.service, account: this.account });
      check("write", payload);
      entries.set(key(this.service, this.account), payload);
    }
    deleteCredential() {
      operations.push({ operation: "remove", service: this.service, account: this.account });
      check("remove");
      return entries.delete(key(this.service, this.account));
    }
  }
  const symbol = Symbol.for("pi-mcp-adapter.test.auth-backend");
  const globals = globalThis as typeof globalThis & { [symbol: symbol]: unknown };
  if (globals[symbol]) throw new Error("auth test backend is already installed");
  globals[symbol] = { Entry };
  const url = new URL("./auth-keyring-fixture.cjs", import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@napi-rs/keyring") return { url, shortCircuit: true };
      if (specifier.startsWith("@napi-rs/keyring-")) throw new Error("Native keyring fallback is forbidden in tests");
      return nextResolve(specifier, context);
    },
    load(specifier, context, nextLoad) {
      if (specifier === url) return {
        format: "commonjs", shortCircuit: true,
        source: 'module.exports = globalThis[Symbol.for("pi-mcp-adapter.test.auth-backend")];',
      };
      return nextLoad(specifier, context);
    },
  });
  return {
    entries, operations, key,
    setMode(value: string) { mode = value; },
    reset() { entries.clear(); operations.length = 0; mode = "memory"; },
    close() { hooks.deregister(); delete globals[symbol]; },
  };
}

export function overridePlatform(platform: NodeJS.Platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  return () => Object.defineProperty(process, "platform", descriptor);
}
