import { currentBuild } from "../../../../scripts/retained-build.mjs";
import { grantTemporarySdkFixture } from "./sdk-grant.ts";
import { appendFileSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureEntrypointDescriptorV1, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
const { getProcessServiceCellV1 } = await import(pathToFileURL(join(currentBuild(new URL("../../", import.meta.url)), "host/service-cell.js")).href);
import { createFixtureChildFactory } from "./sdk-view-provider/src/child-factory.ts";
import { Theme } from "@earendil-works/pi-coding-agent";

const root = process.env.PI_SDK_VIEW_ROOT;
const log = value => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ at: Date.now(), ...value }) + "\n");
export default function fixture(pi) {
  const state = globalThis[Symbol.for("b3-view-fixture")] ??= { contexts: new Map() };
  let observedView, activeView, observing = false;
  const viewContext = new AsyncLocalStorage(), viewRecords = new WeakMap(), wrappedViews = new WeakSet(), usedTokens = new Set();
  const viewBoundary = (kind, token = viewContext.getStore()?.token, monotonicAt = performance.now()) => {
    if (token === undefined) {
      if (observing) throw new Error(`View ${kind} boundary has no ManagedInteractive.open async context`);
      return;
    }
    log({ event: "view-boundary", token, kind, monotonicAt });
    // Keep boundary order in the same PTY stream as committed frames, independent of driver read latency.
    process.stdout.write(`\x1b]777;fixture-view;${token};${kind}\x07`);
  };
  if (process.env.PI_SDK_VIEW_STATUSLINE === "1") {
    const hosts = state.footerHosts ??= [];
    hosts.push = function (...records) {
      for (const record of records) {
        let mounts = record.mounts;
        const token = viewContext.getStore()?.token;
        if (observing && record.role === "child" && token === undefined) throw new Error("Child footer has no ManagedInteractive.open async context");
        Object.defineProperty(record, "mounts", { enumerable: true, configurable: true,
          get: () => mounts, set(value) { mounts = value; if (value === 1 && record.role === "child") viewBoundary("mounted", token); } });
      }
      return Array.prototype.push.apply(this, records);
    };
  }
  createFixtureChildFactory()(pi);
  const descriptor = captureEntrypointDescriptorV1(join(dirname(fileURLToPath(import.meta.url)), "sdk-view-provider/src/child.ts"));
  const registry = getOrCreateChildCapabilityRegistryV1();
  const manifest = { version: 1, owner_id: "b3-faux-provider", main_entrypoint: captureEntrypointDescriptorV1(fileURLToPath(import.meta.url)),
    targets: { "pi-subagents": { child_entrypoint: descriptor, activation: "required-only", commands: [], tools: [],
      providers: [{ provider_id: "fixture", service_tiers: [], service_tier_application: "none" }], hooks: [], requires: [],
      sdk_provider_factory: { provider_id: "fixture", package_manifest: captureEntrypointDescriptorV1(fileURLToPath(new URL("./sdk-view-provider/package.json", import.meta.url))), module: captureEntrypointDescriptorV1(fileURLToPath(new URL("./sdk-view-provider/src/child-factory.ts", import.meta.url))), export: "createFixtureChildFactory", config: {}, artifacts: [] },
    } } };
  grantTemporarySdkFixture(manifest, "pi-subagents");
  const registration = registry.register({ version: 1, manifest });
  const cursor = globalThis[Symbol.for("b3-view-controls")] ??= { processed: 0 };
  const originalSignals = process.listeners("SIGTERM");
  let ctx, editor, originalEditor, starts = 0, bindingLease, generation = 0, working = false;
  let mainRunGate;
  pi.on("before_agent_start", async () => {
    if (!mainRunGate) return;
    log({ event: "main-run-held" });
    await mainRunGate.promise;
  });
  const cell = getProcessServiceCellV1();
  pi.on("session_start", (_event, context) => {
    ctx = context; starts++;
    bindingLease?.release();
    bindingLease = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: ctx.sessionManager.getSessionId(), runtime_generation: ++generation, mode: ctx.mode });
    if (ctx.hasUI) {
      const notify = ctx.ui.notify;
      ctx.ui.notify = function (message, ...args) {
        if (message.includes("主题不随文件热更新")) log({ event: "stock-theme-notice", message });
        return notify.call(this, message, ...args);
      };
      const factory = ctx.ui.getEditorComponent();
      if (factory) ctx.ui.setEditorComponent(new Proxy(factory, { apply(target, receiver, args) { editor = Reflect.apply(target, receiver, args); originalEditor ??= editor; return editor; } }));
    }
    log({ event: "main-ready", starts });
  });
  pi.on("session_shutdown", event => { log({ event: "main-shutdown", reason: event.reason }); bindingLease?.release(); clearInterval(timer); registration.release(); });
  const snapshot = () => {
    const binding = cell.service?.binding(ctx.sessionManager.getSessionId());
    const child = globalThis[Symbol.for("b3-view-fixture")]?.contexts.get("child");
    let childState;
    try { childState = { childDraft: child?.hasUI ? child.ui.getEditorText() : undefined, childMode: child?.mode, model: child?.model?.id, thinking: child?.thinkingLevel }; }
    catch { childState = { childMode: "disposed" }; }
    return { mainDraft: ctx.ui.getEditorText(), mainIdle: ctx.isIdle(), editorSame: editor === originalEditor, starts, ...childState,
      theme: { setting: pi.getSettings().theme, name: ctx.ui.theme.name, accent: ctx.ui.theme.getFgAnsi("accent"), warning: ctx.ui.theme.getFgAnsi("warning"), thinking: ctx.ui.theme.getFgAnsi("thinkingOff"), namedAccent: ctx.ui.getTheme(pi.getSettings().theme)?.getFgAnsi("accent") },
      listeners: { stdin: process.stdin.listenerCount("data"), sigterm: process.listenerCount("SIGTERM"), sighup: process.listenerCount("SIGHUP"), uncaught: process.listenerCount("uncaughtException"), signalNames: process.listeners("SIGTERM").map(fn => fn.name), inputErrors: process.stdin.listenerCount("error"), outputErrors: process.stdout.listenerCount("error"), raw: process.stdin.isRaw },
      memory: process.memoryUsage(), mainHandlersPreserved: originalSignals.every(handler => process.listeners("SIGTERM").includes(handler)),
      driftPreserved: process.listeners("SIGTERM").includes(globalThis[Symbol.for("b3-view-fixture")]?.drift),
      presentationProviders: globalThis[Symbol.for("pi.claude-style.custom-entry-presentations.v1")]?.providers?.size,
      footerHosts: globalThis[Symbol.for("b3-view-fixture")]?.footerHosts?.map(({ component, ...record }) => ({
        ...record, rows: component?.render(112),
        clickConsumed: record.role === "child" ? component?.handleMouse?.({ type: "click", button: "left", x: 1, y: 0, screenX: 1, screenY: 0, width: 112, height: 1, shift: false, alt: false, ctrl: false })?.handled === true : undefined,
      })),
      agents: binding?.host.snapshot().agents.slice().sort((a,b)=>a.agent.task_path.localeCompare(b.agent.task_path)).map(item => ({ id: item.agent.agent_id, path: item.agent.task_path, lifecycle: item.agent.lifecycle, unread: [...binding.host.snapshot().root.inbox,...item.inbox].filter(inbox => !inbox.ui_read_at).length, tasks: item.tasks.map(task => ({ id: task.task_id, phase: task.phase, outcome: task.outcome, message: task.message,
        runtimeGeneration: task.runtime_generation, interruptAt: task.interrupt_requested_at, interruptGeneration: task.interrupt_generation })), mailbox: item.mailbox, native: join(binding.store.mainRoot, item.agent.conversation.relative_path) })),
      viewObservation: activeView && { token: activeView.token, closed: activeView.closed },
      diagnostics: cell.service?.diagnostics() };
  };
  const execute = async command => {
    if (command.op === "hold-main-run") {
      if (mainRunGate) throw new Error("Main run is already held");
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      mainRunGate = { promise, release };
      return;
    }
    if (command.op === "release-main-run") {
      if (!mainRunGate) throw new Error("Main run is not held");
      mainRunGate.release();
      mainRunGate = undefined;
      return;
    }
    if (command.op === "snapshot") return snapshot();
    // History installs no provider factory, so its foreground state must not use the old execution context.
    if (command.op === "main-foreground") return cell.service.binding(ctx.sessionManager.getSessionId()).terminalOwner.isMainForeground;
    if (command.op === "observe-view") {
      if (!/^\d+$/.test(command.token)) throw new Error("Expected a numeric view observation token");
      const runtime = cell.service.binding(ctx.sessionManager.getSessionId()).runtime;
      if (usedTokens.has(command.token)) throw new Error("View observation token was already used");
      if (!observing) {
        observing = true;
        const childForView = runtime.childForView;
        // sdk-child-view selects child.view from this public lookup immediately before current.open().
        // Wrap that actual instance, not an imported class from a different native/Jiti module realm.
        // This observes the existing lookup without ensuring execution or replacing a history-only view.
        runtime.childForView = async function (...args) {
          const child = await childForView.apply(this, args), view = child?.view;
          if (view && !wrappedViews.has(view)) {
            wrappedViews.add(view);
            const open = view.open, close = view.close;
            view.open = function (...args) {
              if (observedView === undefined || usedTokens.has(observedView)) throw new Error("ManagedInteractive.open has no fresh observation token");
              const record = { token: observedView, closed: false, expired: false, startedAt: performance.now() };
              usedTokens.add(record.token); viewRecords.set(this, record); activeView = record;
              const loaded = this.onLoaded;
              this.onLoaded = async (...loadedArgs) => {
                const result = await loaded?.apply(this, loadedArgs);
                // enter() completes initialization synchronously after the onLoaded await settles.
                setImmediate(() => {
                  if (!record.closed && activeView === record && this.attached) viewBoundary("ready", record.token);
                });
                return result;
              };
              return viewContext.run(record, () => { viewBoundary("init-start", record.token, record.startedAt); return open.apply(this, args); });
            };
            view.close = function (...args) {
              const record = viewRecords.get(this);
              if (record && !record.closed) { record.closed = true; viewBoundary("close", record.token); }
              return close.apply(this, args);
            };
          }
          return child;
        };
        const report = runtime.options.reportOperationalError;
        runtime.options.reportOperationalError = function (input) {
          if (String(input.error).includes("initialization exceeded 2000 ms")) {
            const record = viewContext.getStore();
            if (!record) throw new Error("Initialization deadline has no ManagedInteractive.open async context");
            record.expired = true;
            viewBoundary("deadline", record.token);
          }
          return report?.call(this, input);
        };
      }
      observedView = command.token;
      return;
    }
    if (command.op === "observe-return") {
      const owner = cell.service.binding(ctx.sessionManager.getSessionId()).terminalOwner;
      const restore = owner.restore, viewToken = activeView?.token;
      const observation = activeView && { viewToken, initElapsedMs: performance.now() - activeView.startedAt, expired: activeView.expired };
      owner.restore = function (...args) {
        owner.restore = restore;
        const startedAt = Date.now();
        const result = restore.apply(this, args);
        const completedAt = Date.now();
        log({ event: "main-restored", token: command.token, viewToken, startedAt, completedAt, mainForeground: owner.isMainForeground });
        return result;
      };
      return observation;
    }
    if (command.op === "hold-binding") {
      globalThis[Symbol.for("b3-view-fixture")].holdBinding = { token: command.token, nth: command.nth, seen: 0 };
      return;
    }
    if (command.op === "hold-loaded") {
      const runtime = cell.service.binding(ctx.sessionManager.getSessionId()).runtime;
      const original = runtime.markViewLoaded.bind(runtime);
      runtime.markViewLoaded = async id => {
        runtime.markViewLoaded = original;
        log({ event: "load-held", token: command.token, viewToken: viewContext.getStore()?.token, monotonicAt: performance.now() });
        await new Promise(resolve => {
          const timer = setInterval(() => { if (existsSync(join(root, `release-load-${command.token}`))) { clearInterval(timer); resolve(); } }, 20);
        });
        await original(id);
        log({ event: "load-returned", token: command.token, viewToken: viewContext.getStore()?.token });
      };
      return;
    }
    if (command.op === "mouse-unread-proof") { const state=cell.service.binding("b3-main").host.snapshot(); return state.agents.map(item=>({id:item.agent.agent_id,name:item.agent.task_name,session:item.agent.conversation.session_id,unread:state.root.inbox.filter(inbox=>item.completions.some(c=>c.completion_id===inbox.completion_id)&&!inbox.ui_read_at).length})); }
    if (command.op === "mouse-spawn") {
      const binding=cell.service.binding("b3-main"), caller={kind:"user",main_session_id:binding.mainSessionId,binding_generation:binding.bindingGeneration,manager_generation:1};
      for(const name of command.names) {const result=await cell.service.executor(binding.mainSessionId)({tool:"spawn_agent",params:{task_name:name,message:"MOUSE_PROOF "+name,fork_turns:"none"},toolCallId:crypto.randomUUID(),context:ctx});if(result.details.outcome==="rejected")throw new Error(JSON.stringify(result.details));}
      return;
    }
    if (command.op === "interrupt-receipts") return cell.service.binding("b3-main").host.snapshot().root.operation_receipts.filter(receipt => receipt.operation === "interrupt-agent");
    if (command.op === "anonymous-theme") {
      const theme = JSON.parse(readFileSync(join(root, "agent/themes/b3-theme.json"), "utf8"));
      const resolve = value => typeof value === "string" && value !== "" && !value.startsWith("#") ? resolve(theme.vars[value]) : value;
      const colors = Object.fromEntries(Object.entries(theme.colors).map(([name, value]) => [name, resolve(value)]));
      const result = ctx.ui.setTheme(new Theme(colors, {}, ctx.ui.theme.getColorMode()));
      if (!result.success) throw new Error(result.error);
      return;
    }
    if (command.op === "internals-report") return [...ctx.sessionManager.getEntries()].reverse().find(entry => entry.type === "custom_message" && entry.customType === "internals");
    if (command.op === "delivery") {
      const binding = cell.service.binding(ctx.sessionManager.getSessionId()), state = binding.host.snapshot();
      return { completions: state.agents.flatMap(item => item.completions.map(completion => completion.completion_id)),
        outboxes: [state.root, ...state.agents].flatMap(item => item.outbox.map(outbox => ({ id: outbox.outbox_id, state: outbox.state, turnSettlement: outbox.turn_settlement?.state, completions: outbox.completion_ids,
          wakeState: outbox.wake_state, recipientSession: outbox.recipient.session_id, handlingProof: outbox.handling_proof,
          settlementKind: outbox.settlement_kind, settlementProof: outbox.settlement_proof_id }))) };
    }
    if (command.op === "internals") {
      const { auditInternals: cc } = await import(pathToFileURL(join(currentBuild(new URL("../../../pi-claude-style/", import.meta.url)), "src/internals.ts")).href);
      const result = { cc: cc() };
      writeFileSync(join(root, `${command.label}-internals.json`), JSON.stringify(result, null, 2));
      return Object.fromEntries(Object.entries(result).map(([name, rows]) => [name, rows.filter(row => ["broken", "missing"].includes(row.state))]));
    }
    if (command.op === "child-draft") { globalThis[Symbol.for("b3-view-fixture")].contexts.get("child").ui.setEditorText(command.text); return; }
    if (command.op === "append-unread") {
      const binding=cell.service.binding(ctx.sessionManager.getSessionId()),target=binding.host.snapshot().agents.find(item=>item.agent.depth===1).agent.agent_id;
      const caller={kind:"user",main_session_id:binding.mainSessionId,binding_generation:binding.bindingGeneration,manager_generation:1};
      const result=await binding.host.resumeAgent({request_id:crypto.randomUUID(),caller,input:{target}});if(!result.ok)throw new Error(result.error.message);
      await binding.runtime.admitViewInput(target,caller,"D_NEST_UI");return;
    }
    if (command.op === "main-draft") { ctx.ui.setEditorText(command.text); return; }
    if (command.op === "title") { ctx.ui.setTitle("MAIN_BACKGROUND_TITLE"); return; }
    if (command.op === "background") { pi.sendUserMessage(command.text, { deliverAs: "followUp" }); return; }
    if (command.op === "child-shutdown") { globalThis[Symbol.for("b3-view-fixture")].contexts.get("child").shutdown(); return; }
    if (command.op === "child-abort") { await globalThis[Symbol.for("b3-view-fixture")].contexts.get("child").abort(); return; }
    if (command.op === "main-shutdown") { ctx.shutdown(); return; }
    if (command.op === "main-quit") { editor.onSubmit("/quit"); return; }
    if (command.op === "main-reload") { editor.onSubmit("/reload"); return; }
    if (command.op === "main-new") { editor.onSubmit("/new"); return; }
    const binding = cell.service?.binding(ctx.sessionManager.getSessionId());
    if (!binding) throw new Error("No binding");
    if (command.op === "close" || command.op === "resume") {
      const target = binding.host.snapshot().agents.find(item=>item.agent.depth===1).agent.agent_id;
      const input = {request_id: crypto.randomUUID(), caller: {kind:"user",main_session_id:binding.mainSessionId,binding_generation:binding.bindingGeneration,manager_generation:1},input:{target, ...(command.force ? {force:true} : {})}};
      const result = await (command.op === "close" ? binding.host.closeAgent(input) : binding.host.resumeAgent(input));
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    if (command.op === "open") { void binding.runtime.openView(binding.host.snapshot().agents.find(item=>item.agent.depth===1).agent.agent_id, binding.terminalOwner, binding.bindingGeneration).catch(error => log({ event: "open-error", error: String(error), stack: error.stack })); return; }
    if (command.op === "reload") { await ctx.ui.setEditorText(""); const entry = pi.getCommands().find(command => command.name === "subagents"); return { entry: !!entry }; }
  };
  let commandsVersion, commands = [];
  const timer = setInterval(() => {
    if (working || !ctx || !existsSync(join(root, "commands.jsonl"))) return;
    const stat = statSync(join(root, "commands.jsonl")), version = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (version !== commandsVersion) {
      commands = readFileSync(join(root, "commands.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      commandsVersion = version;
    }
    const command = commands[cursor.processed]; if (!command) return;
    working = true; cursor.processed++;
    void execute(command).then(result => log({ event: "control", id: command.id, result }), error => log({ event: "control", id: command.id, error: String(error), stack: error.stack })).finally(() => { working = false; });
  }, 20);
}
