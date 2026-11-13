// 测试侧钩子：只改写内存中的未打包宿主模块。
import { registerHooks, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { emit } from "./transport.mjs";
import { performance } from "node:perf_hooks";

const stats = () => ({ handlers: {}, frames: [], renderMs: 0 });
let current = stats();
let recording = true;
const timers = new Map();
const subprocesses = new Map();
const bench = (globalThis.__piBench = {
  imports: [],
  factories: [],
  hooks: [],
  emit,
  reset() {
    current = stats();
    recording = true;
  },
  stop() {
    recording = false;
    return { ...bench.sample(), at: performance.now() };
  },
  sample() {
    return {
      ...current,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      timers: [...timers.values()].map((value) => ({ ...value })),
      subprocesses: [...subprocesses.values()].map((value) => ({ ...value })),
    };
  },
  async timed(kind, path, fn) {
    const start = performance.now();
    const bucket = current;
    const wasRecording = recording;
    let syncEnd;
    try {
      const value = fn();
      syncEnd = performance.now();
      return await value;
    } finally {
      const end = performance.now(),
        ms = end - start,
        syncMs = (syncEnd ?? end) - start;
      if (kind === "import") bench.imports.push({ path, ms });
      else if (kind === "factory") bench.factories.push({ path, ms });
      else if (wasRecording && recording && current === bucket) {
        const key = `${path}:${kind}`;
        const value = (current.handlers[key] ??= { ms: 0, syncMs: 0 });
        value.ms += ms;
        value.syncMs += syncMs;
      }
    }
  },
  frame(ms, latency) {
    if (!recording) return;
    current.renderMs += ms;
    current.frames.push({ ms, latency });
  },
});

// 空闲诊断保留原生 handle、ref/unref 和取消语义。
if (process.env.PI_BENCH_TIMERS === "1") {
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const start = performance.now(),
      child = spawn(...args);
    const command = JSON.stringify([args[0], Array.isArray(args[1]) ? args[1] : []]);
    const record = subprocesses.get(command) ?? {
      command,
      launches: 0,
      completed: 0,
      wallMs: 0,
    };
    subprocesses.set(command, record);
    record.launches++;
    child.once("exit", () => {
      record.completed++;
      record.wallMs += performance.now() - start;
    });
    return child;
  };
  syncBuiltinESMExports();
  for (const name of ["setTimeout", "setInterval"]) {
    const original = globalThis[name];
    globalThis[name] = (fn, delay, ...args) => {
      if (typeof fn !== "function") return original(fn, delay, ...args);
      const stack = new Error().stack.split("\n").slice(2, 8).join("\n");
      const key = `${name}:${delay}:${stack}`;
      const record = timers.get(key) ?? { name, delay, stack, calls: 0, ms: 0 };
      timers.set(key, record);
      return original(
        function (...values) {
          const start = performance.now();
          try {
            return fn.apply(this, values);
          } finally {
            record.calls++;
            record.ms += performance.now() - start;
          }
        },
        delay,
        ...args,
      );
    };
  }
}

function replace(source, from, to, label) {
  if (source.split(from).length !== 2) throw new Error(`Pi 基准钩子的源码锚点已变化： ${label}`);
  bench.hooks.push(label);
  return source.replace(from, to);
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes("/@earendil-works/")) return result;
    let source =
      typeof result.source === "string" ? result.source : result.source && Buffer.from(result.source).toString();
    if (!source) return result;
    if (url.endsWith("/core/extensions/loader.js")) {
      source = replace(
        source,
        "await jiti.import(extensionPath, { default: true })",
        'await globalThis.__piBench.timed("import", extensionPath, () => jiti.import(extensionPath, { default: true }))',
        "import",
      );
      source = replace(
        source,
        "errors.push({ path: extPath, error });",
        'globalThis.__piBench.emit({ type: "error", path: extPath, error });\nerrors.push({ path: extPath, error });',
        "loadErrors",
      );
      source = replace(
        source,
        "await factory(load.api);",
        'await globalThis.__piBench.timed("factory", extensionPath, () => factory(load.api));',
        "factory",
      );
      source = replace(
        source,
        "const registeredHandler = (...args) => handler(...args);",
        "const registeredHandler = (...args) => globalThis.__piBench.timed(event, extension.path, () => handler(...args));",
        "handler",
      );
    }
    if (url.endsWith("/core/agent-session-runtime.js")) {
      source += `
for (const method of ["teardownCurrent", "finishSessionReplacement"]) {
  const original = AgentSessionRuntime.prototype[method];
  AgentSessionRuntime.prototype[method] = function(...args) {
    return globalThis.__piBench.timed(method, "host", () => original.apply(this, args));
  };
}
for (const method of ["newSession", "switchSession"]) {
  const original = AgentSessionRuntime.prototype[method];
  if (typeof original !== "function") throw new Error("Pi session replacement 钩子已变化");
  AgentSessionRuntime.prototype[method] = async function(...args) {
    const start = performance.now();
    const imports = globalThis.__piBench.imports.length;
    const factories = globalThis.__piBench.factories.length;
    globalThis.__piBench.reset();
    try {
      return await original.apply(this, args);
    } finally {
      globalThis.__piBench.emit({ type: "switch-complete", method, elapsedMs: performance.now() - start,
        ...globalThis.__piBench.sample(), imports: globalThis.__piBench.imports.slice(imports),
        factories: globalThis.__piBench.factories.slice(factories) });
    }
  };
}
`;
      bench.hooks.push("sessionReplacement");
    }
    if (url.endsWith("/modes/interactive/components/session-selector.js")) {
      source += `
const benchLoadScope = SessionSelectorComponent.prototype.loadScope;
SessionSelectorComponent.prototype.loadScope = async function(...args) {
  const result = await benchLoadScope.apply(this, args);
  globalThis.__piBench.emit({ type: "selector-ready" });
  return result;
};
`;
      bench.hooks.push("sessionSelector");
    }
    if (url.endsWith("/core/extensions/runner.js")) {
      source += `
const benchError = ExtensionRunner.prototype.emitError;
const benchEmit = ExtensionRunner.prototype.emit;
if (typeof benchError !== "function" || typeof benchEmit !== "function") {
  throw new Error("Pi 事件分发钩子已变化");
}
ExtensionRunner.prototype.emitError = function(error) {
  globalThis.__piBench.emit({ type: "error", ...error });
  return benchError.call(this, error);
};
ExtensionRunner.prototype.emit = async function(event, ...args) {
  try {
    return await benchEmit.call(this, event, ...args);
  } finally {
    if (event.type === "agent_settled") globalThis.__piBench.onSettled?.();
  }
};
`;
      bench.hooks.push("extensionErrors", "settledBoundary");
    }
    if (url.endsWith("/pi-tui/dist/tui.js")) {
      source += `
const benchRequest = TuiBase.prototype.requestRender;
if (typeof benchRequest !== "function") throw new Error("Pi requestRender 钩子已变化");
TuiBase.prototype.requestRender = function(...args) {
  this.__benchRequested ??= performance.now();
  return benchRequest.apply(this, args);
};
`;
      bench.hooks.push("requestRender");
    }
    for (const [file, cls] of [
      ["tui-main-screen.js", "TuiMainScreen"],
      ["tui-alt-screen.js", "TuiAltScreen"],
    ]) {
      if (url.endsWith("/pi-tui/dist/" + file)) {
        source += `
const benchRender = ${cls}.prototype.doRender;
if (typeof benchRender !== "function") throw new Error("Pi ${cls} 绘制钩子已变化");
${cls}.prototype.doRender = function(...args) {
  const start = performance.now();
  const requested = this.__benchRequested ?? start;
  this.__benchRequested = undefined;
  try {
    return benchRender.apply(this, args);
  } finally {
    const end = performance.now();
    globalThis.__piBench.frame(end - start, end - requested);
  }
};
`;
        bench.hooks.push(cls);
      }
    }
    return { ...result, source };
  },
});
