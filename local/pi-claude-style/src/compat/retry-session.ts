/** Session facts survive view disposal; no TUI, context or timer is retained. */
import { AgentSession, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { declareProbes, markBroken, markOk, type Probe } from "../internals.ts";
import { originalPresentationMethod } from "../presentation-owner.ts";
import { createRetrySnapshot, type RetrySnapshot } from "../working-retry.ts";

type Bind = AgentSession["bindExtensions"];
interface Entry { snapshot?: RetrySnapshot; closed: boolean; stop(): void }
interface Patch {
  original: Bind; patched: Bind; owners: Set<symbol>;
  init: InteractiveMode["init"]; patchedInit: InteractiveMode["init"];
  views: Set<(mode: InteractiveMode) => void>;
}
interface State {
  sessions: WeakMap<AgentSession, Entry>;
  managers: WeakMap<object, Entry>;
  patches: WeakMap<object, WeakMap<object, Patch>>;
}
const KEY = Symbol.for("pi.claude-style.retry-sessions.v2");
const globals = globalThis as Record<PropertyKey, unknown>;
const state = (): State => (globals[KEY] ??= { sessions: new WeakMap(), managers: new WeakMap(), patches: new WeakMap() }) as State;
const hostPatch = () => state().patches.get(AgentSession.prototype)?.get(InteractiveMode.prototype);
const nativeBind = () => {
  const method = AgentSession.prototype.bindExtensions, patch = hostPatch();
  return patch && patch.patched === method ? patch.original : method;
};
function bindShape(): boolean {
  const method = nativeBind();
  return typeof method === "function" && method.length === 1 &&
    ["_sessionStartEvent", "_applyExtensionBindings", "emit"].every(token => String(method).includes(token));
}
function viewShape(): boolean {
  const current = originalPresentationMethod(InteractiveMode.prototype, "init"), patch = hostPatch();
  const method = patch && patch.patchedInit === current ? patch.init : current;
  return typeof method === "function" && method.length === 0 &&
    ["rebindCurrentSession", "renderInitialMessages"].every(token => String(method).includes(token));
}
export const PROBES: readonly Probe[] = [
  { id: "working.retrySession", needs: "AgentSession.prototype.bindExtensions: capture public subscribe/sessionManager before binding",
    breaks: "重试仍只支持收到事件的当前视图；后台首次进入与重进不恢复", check: bindShape },
  { id: "working.retryView", needs: "InteractiveMode.prototype.init: project retry after native initialization",
    breaks: "同上：保留当前视图重试，进入视图时不投影 session 快照", check: viewShape },
];
export interface RetryRecording { snapshot(): RetrySnapshot | undefined; available: boolean; dispose(): void }

function watch(session: AgentSession): void {
  const shared = state();
  if (shared.sessions.get(session)?.closed === false) return;
  const entry: Entry = { closed: false, stop() {} };
  const unsubscribe = session.subscribe(event => {
    if (event.type === "auto_retry_start") entry.snapshot = createRetrySnapshot(event, Date.now());
    else if (event.type === "agent_start" || event.type === "auto_retry_end" || event.type === "agent_settled") entry.snapshot = undefined;
  });
  entry.stop = () => { entry.snapshot = undefined; entry.closed = true; unsubscribe(); entry.stop = () => {}; };
  shared.sessions.set(session, entry);
  shared.managers.set(session.sessionManager, entry);
}

/** Both prototype wrappers are audited even though their declarations are public:
 * Pi has not promised that extension-owned prototype wrapping is stable.
 */
export function installRetryRecording(pi: ExtensionAPI): RetryRecording {
  declareProbes(PROBES);
  let compatible = true;
  for (const probe of PROBES) {
    let ok = false;
    try { ok = probe.check?.() === true; } catch { /* unreadable boundary */ }
    if (ok) markOk(probe.id);
    else { compatible = false; markBroken(probe.id, "Retry restoration unavailable; keeping current-view retry handling"); }
  }
  if (!compatible) return { available: false, snapshot: () => undefined, dispose() {} };
  const shared = state();
  // Pi 1.5 Main and SDK assemblies may expose different host prototype pairs.
  // Share leases only within the exact pair; native shape drift still fails
  // the probes above, rather than adopting another host's wrappers.
  const patches = shared.patches.get(AgentSession.prototype) ?? new WeakMap<object, Patch>();
  shared.patches.set(AgentSession.prototype, patches);
  if (!patches.has(InteractiveMode.prototype)) {
    const original = AgentSession.prototype.bindExtensions;
    const patched: Bind = function (this: AgentSession, bindings) {
      try { watch(this); } catch { markBroken("working.retrySession", "Cannot subscribe; keeping current-view retry handling"); }
      return original.call(this, bindings);
    };
    const init = InteractiveMode.prototype.init, views = new Set<(mode: InteractiveMode) => void>();
    const patchedInit: InteractiveMode["init"] = async function (this: InteractiveMode) {
      await init.call(this);
      for (const project of views) {
        try { project(this); } catch { markBroken("working.retryView", "Cannot project retry; keeping current-view handling"); }
      }
    };
    patches.set(InteractiveMode.prototype, { original, patched, init, patchedInit, views, owners: new Set() });
    AgentSession.prototype.bindExtensions = patched;
    InteractiveMode.prototype.init = patchedInit;
  }
  const patch = patches.get(InteractiveMode.prototype)!, owner = Symbol("retry-recording");
  patch.owners.add(owner);
  let entry: Entry | undefined, disposed = false;
  const stopStart = pi.on("session_start", (_event, ctx) => {
    try { entry = shared.managers.get(ctx.sessionManager); } catch { entry = undefined; }
  });
  const recording: RetryRecording = {
    available: true,
    snapshot: () => disposed || entry?.closed ? undefined : entry?.snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      entry?.stop(); entry = undefined;
      stopStart(); stopShutdown();
      patch.owners.delete(owner);
      if (patch.owners.size === 0) {
        if (AgentSession.prototype.bindExtensions === patch.patched) AgentSession.prototype.bindExtensions = patch.original;
        if (InteractiveMode.prototype.init === patch.patchedInit) InteractiveMode.prototype.init = patch.init;
        if (patches.get(InteractiveMode.prototype) === patch) patches.delete(InteractiveMode.prototype);
      }
    },
  };
  const stopShutdown = pi.on("session_shutdown", () => recording.dispose());
  return recording;
}

/** View-scoped consumer; session recording itself never retains a view. */
export function installRetryViewProjection(project: (mode: InteractiveMode) => void): () => void {
  const views = hostPatch()?.views;
  views?.add(project);
  return () => { views?.delete(project); };
}
