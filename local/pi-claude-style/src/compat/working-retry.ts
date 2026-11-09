/** Two private Pi 1.3 seams: raw event dispatch and the status mount boundary.
 * Never read session/editor/status fields on the live receiver. The original
 * event handler retains escape binding, cancellation and final-error handling.
 */
import { InteractiveMode, type AgentSessionEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRetryViewProjection } from "./retry-session.ts";
import type { Loader, Component } from "@earendil-works/pi-tui";
import { declareProbes, markBroken, markOk, type Probe } from "../internals.ts";
import { originalPresentationMethod, presentationPrototype, presentationReceiverBelongsTo } from "../presentation-owner.ts";

export type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
export interface WorkingRetryIndicator extends Component {
  kind: "working";
  dispose(): void;
  setMessage: Loader["setMessage"];
  setIndicator: Loader["setIndicator"];
}
interface NativeIndicator extends Component { kind: string; dispose(): void }
type HandleEvent = (this: unknown, event: AgentSessionEvent) => Promise<void>;
type ShowIndicator = (this: unknown, indicator: NativeIndicator) => void;
interface RetryPrototype { handleEvent: HandleEvent; showStatusIndicator: ShowIndicator }
const prototype = InteractiveMode.prototype as unknown as RetryPrototype;

/** Behavioural checks work in both source and Bun's renamed final binary.
 * Synthetic receivers belong to this probe; none of these fields are read
 * from a real Pi instance. Dispose every native timer created by the probe.
 */
function eventBehavior(method: unknown): method is HandleEvent {
  if (typeof method !== "function" || method.length !== 1) return false;
  let indicator: NativeIndicator | undefined;
  let aborted = 0;
  let cleared = "";
  let error = "";
  const escape = () => {};
  const receiver = {
    isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} },
    defaultEditor: { onEscape: escape }, retryEscapeHandler: undefined,
    session: { abortRetry() { aborted++; } }, ui: { requestRender() {} },
    showStatusIndicator(value: NativeIndicator) { indicator = value; },
    clearStatusIndicator(kind: string) { cleared = kind; },
    showError(value: string) { error = value; }, pendingTools: new Map(),
  };
  const invoke = (event: unknown) => {
    const result = method.call(receiver, event);
    if (!result || typeof result.then !== "function") return false;
    void result.catch(() => {});
    return true;
  };
  try {
    if (!invoke({ type: "auto_retry_start", attempt: 2, maxAttempts: 10, delayMs: 4_000, errorMessage: "fetch failed" })) return false;
    if (indicator?.kind !== "retry" || typeof indicator.dispose !== "function") return false;
    receiver.defaultEditor.onEscape();
    if (aborted !== 1 || receiver.retryEscapeHandler !== escape) return false;
    if (!invoke({ type: "agent_start" }) || receiver.defaultEditor.onEscape !== escape) return false;
    indicator.dispose();
    invoke({ type: "auto_retry_start", attempt: 2, maxAttempts: 10, delayMs: 4_000, errorMessage: "fetch failed" });
    indicator.dispose();
    if (!invoke({ type: "auto_retry_end", success: false, attempt: 2, finalError: "fetch failed" })) return false;
    return receiver.defaultEditor.onEscape === escape && cleared === "retry" && error === "Retry failed after 2 attempts: fetch failed";
  } catch { return false; }
  finally { indicator?.dispose(); }
}

/** Factory installation precedes theme initialization. Check only stable
 * protocol literals/property names here; exercise behaviour on the first live
 * retry, when native RetryStatusIndicator can safely use the user's theme.
 * No local/class variable names are assumed in the bundled binary.
 */
function eventShape(method: unknown): method is HandleEvent {
  if (typeof method !== "function" || method.length !== 1) return false;
  const source = Function.prototype.toString.call(method);
  return ["auto_retry_start", "auto_retry_end", "agent_start", "abortRetry", "retryEscapeHandler", "showStatusIndicator", "Retry failed after"].every(token => source.includes(token));
}

function indicatorShape(method: unknown): method is ShowIndicator {
  if (typeof method !== "function" || method.length !== 1) return false;
  try {
    for (const embedded of [false, true]) {
      let disposed = 0, cleared = 0;
      const mounted: NativeIndicator[] = [];
      const indicator = { kind: "working", dispose() {}, render: () => [], invalidate() {} };
      const receiver = {
        activeStatusIndicator: { dispose() { disposed++; } }, activeWorkingIndicatorEmbedded: true,
        statusContainer: { clear() { cleared++; }, addChild(value: NativeIndicator) { mounted.push(value); } },
        setEditorWorkingStatusIndicator(value: NativeIndicator | undefined) { return value ? embedded : false; },
      };
      method.call(receiver, indicator);
      if (disposed !== 1 || cleared !== 1 || receiver.activeStatusIndicator !== indicator
        || receiver.activeWorkingIndicatorEmbedded !== embedded || mounted.length !== Number(!embedded)
        || (!embedded && mounted[0] !== indicator)) return false;
    }
    return true;
  } catch { return false; }
}

export const PROBES: readonly Probe[] = [
  { id: "working.retryEvents", needs: "InteractiveMode.prototype.handleEvent(auto_retry_start/auto_retry_end/agent_start)",
    breaks: "重试保留 Pi 原生 RetryStatusIndicator 与 Esc 取消", check: () => eventShape(originalPresentationMethod(prototype, "handleEvent")) },
  { id: "working.retryIndicator", needs: "InteractiveMode.prototype.showStatusIndicator(StatusIndicator)",
    breaks: "重试保留 Pi 原生 RetryStatusIndicator 与 Esc 取消", check: () => indicatorShape(originalPresentationMethod(prototype, "showStatusIndicator")) },
];

export function installWorkingRetry(
  pi: ExtensionAPI | undefined,
  begin: (event: RetryStart) => WorkingRetryIndicator | undefined,
  end: () => void,
  restore?: () => WorkingRetryIndicator | undefined,
): () => void {
  declareProbes(PROBES);
  // Probe the unwrapped methods: presentationPrototype dispatchers intentionally
  // have a different arity and route to this owner's local implementation.
  let local: RetryPrototype, handle: HandleEvent, show: ShowIndicator;
  let eventsOk: boolean, indicatorOk: boolean;
  try {
    local = presentationPrototype(pi, prototype, "mode");
    handle = local.handleEvent;
    show = local.showStatusIndicator;
    eventsOk = eventShape(originalPresentationMethod(prototype, "handleEvent"));
    indicatorOk = indicatorShape(originalPresentationMethod(prototype, "showStatusIndicator"));
  } catch {
    for (const probe of PROBES) markBroken(probe.id, "Retry boundary unreadable; keeping native retry display");
    return () => {};
  }
  for (const [id, ok] of [["working.retryEvents", eventsOk], ["working.retryIndicator", indicatorOk]] as const) {
    if (ok) markOk(id);
    else markBroken(id, "Pi 1.3 retry contract changed; keeping native retry display");
  }
  if (!eventsOk || !indicatorOk) return () => {};
  const waiting = new WeakMap<object, RetryStart>();
  let verified = false;
  let enabled = true;
  const patchedShow: ShowIndicator = function (indicator) {
    const event = enabled ? waiting.get(this as object) : undefined;
    if (event && indicator.kind === "retry") {
      let replacement: WorkingRetryIndicator | undefined;
      try { replacement = begin(event); } catch { end(); }
      if (replacement) {
        // Dispose the unused native countdown and spinner before mounting CC's
        // public Loader. No native retry timer survives the handoff.
        indicator.dispose();
        return show.call(this, replacement);
      }
    }
    return show.call(this, indicator);
  };
  const patchedHandle: HandleEvent = function (event) {
    if (!enabled) return handle.call(this, event);
    if (event.type === "agent_start" || event.type === "auto_retry_end") end();
    if (event.type !== "auto_retry_start") return handle.call(this, event);
    if (!verified) {
      verified = eventBehavior(handle);
      if (!verified) {
        enabled = false;
        markBroken("working.retryEvents", "Live retry behaviour changed; keeping native retry display");
        return handle.call(this, event);
      }
    }
    waiting.set(this as object, event);
    try {
      return handle.call(this, event).finally(() => { waiting.delete(this as object); });
    } catch (error) {
      waiting.delete(this as object);
      throw error;
    }
  };
  const stopProjection = restore ? installRetryViewProjection(mode => {
    if (!presentationReceiverBelongsTo(pi, mode)) return;
    const replacement = restore();
    if (replacement) show.call(mode, replacement);
  }) : () => {};
  local.showStatusIndicator = patchedShow;
  local.handleEvent = patchedHandle;
  return () => {
    stopProjection();
    if (local.handleEvent === patchedHandle) local.handleEvent = handle;
    if (local.showStatusIndicator === patchedShow) local.showStatusIndicator = show;
    end();
  };
}
