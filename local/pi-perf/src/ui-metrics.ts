/**
 * TUI frame instrumentation.
 *
 * Pi does not expose a "frame painted" extension event. We obtain the live TUI
 * through the public widget factory, then wrap the method owners reached from
 * that instance. This avoids importing another copy of pi-tui while still
 * measuring the boundary the user actually sees.
 */

import { performance } from "node:perf_hooks";
import type { TUI } from "@earendil-works/pi-tui";

export interface UiMetricDetail {
  mode?: string;
  fullRedraw?: boolean;
  coalesced?: number;
  [key: string]: unknown;
}

export interface UiMetricObserver {
  now(): number;
  record(name: string, ms: number, detail?: UiMetricDetail): void;
  painted(at: number): void;
  terminalInput?(data: string, at: number, detail?: UiMetricDetail): void;
  inputHandled?(data: string, startedAt: number, finishedAt: number, detail?: UiMetricDetail): void;
}

export interface UiInstrumentationStatus {
  requestRender: boolean;
  doRender: boolean;
  handleTerminalInput: boolean;
  detail?: string;
}

interface RenderState {
  requestedAt?: number;
  inputActions?: Map<InputActionKind, PendingInputAction>;
  dimensions?: TerminalDimensions;
  resizePendingAt?: number;
  resizeBurst?: ResizeBurst;
}

interface TerminalDimensions {
  columns: number;
  rows: number;
}

interface ResizeBurst {
  interaction: number;
  startedAt: number;
  lastChangeAt: number;
  lastPaintAt?: number;
  changes: number;
  frames: number;
  fullRedraws: number;
  from: TerminalDimensions;
  to: TerminalDimensions;
  settleTimer?: ReturnType<typeof setTimeout>;
}

export type InputActionKind = "typing" | "submit" | "overlay" | "other";

interface PendingInputAction {
  interaction: number;
  startedAt: number;
  requestedAt?: number;
  coalesced: number;
  bytes: number;
  characters: number;
  overlayClosed?: boolean;
  inputContext?: UiInputContext;
}

export type UiInputContext = "questionnaire";

export interface UiMetricStats {
  name: string;
  count: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface UiPerfSnapshot {
  at: number;
  metrics: UiMetricStats[];
  owners: string[];
  runtime?: UiRuntimeSnapshot;
}

export interface UiRuntimeSnapshot {
  at: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  eventLoopUtilization: number;
  eventLoopDelayP95Ms?: number;
}

export interface UiObservabilityRegistryV3 {
  version: 3;
  acquire(owner: string, observer: UiMetricObserver): () => void;
  getStatus(): UiInstrumentationStatus & { provider: string; enabled: boolean; subscribers: number };
  snapshot(): UiPerfSnapshot;
  reset(owner?: string): void;
  setEnabled?(enabled: boolean, owner?: string): void;
  updateRuntime?(runtime: UiRuntimeSnapshot): void;
}

interface RegistryState {
  api: UiObservabilityRegistryV3;
  observers: Map<number, { owner: string; observer: UiMetricObserver }>;
  nextObserverId: number;
  samples: Map<string, number[]>;
  status: UiInstrumentationStatus;
  enabled: boolean;
  enabledOwners: Set<string>;
  providerOwners: Set<string>;
  requestOwners: WeakSet<object>;
  renderOwners: WeakSet<object>;
  inputOwners: WeakSet<object>;
  renderStates: WeakMap<object, RenderState>;
  runtime?: UiRuntimeSnapshot;
}

export const UI_OBSERVABILITY_KEY = Symbol.for("pi.perf.ui-metrics.v3");
const LEGACY_UI_OBSERVABILITY_KEY = Symbol.for("pi.perf.ui-metrics.v2");
const SAMPLE_WINDOW = 512;
const RESIZE_SETTLE_MS = 250;
let ownedRegistry: RegistryState | undefined;
let nextInputInteraction = 1;
let nextResizeInteraction = 1;
let currentInputContext: UiInputContext | undefined;

/** Semantic context supplied by the provider while a modal tool owns input. */
export function setUiInputContext(context: UiInputContext | undefined): void {
  currentInputContext = context;
}

function percentile(samples: readonly number[], value: number): number {
  if (samples.length === 0) return 0;
  const index = Math.max(0, Math.min(samples.length - 1, Math.ceil(samples.length * value / 100) - 1));
  return samples[index] ?? 0;
}

function registry(): RegistryState {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = host[UI_OBSERVABILITY_KEY];
  if (ownedRegistry && existing === ownedRegistry.api) return ownedRegistry;
  const legacyPresent = !existing && host[LEGACY_UI_OBSERVABILITY_KEY] !== undefined;
  if (existing || legacyPresent) {
    const external = existing as Partial<UiObservabilityRegistryV3>;
    const compatible = !legacyPresent && external.version === 3 && typeof external.acquire === "function" &&
      typeof external.getStatus === "function" && typeof external.snapshot === "function" &&
      typeof external.reset === "function";
    const unavailable: UiObservabilityRegistryV3 = compatible
      ? external as UiObservabilityRegistryV3
      : {
        version: 3,
        acquire: () => () => {},
        getStatus: () => ({
          requestRender: false,
          doRender: false,
          handleTerminalInput: false,
          provider: "unavailable",
          enabled: false,
          subscribers: 0,
          detail: legacyPresent
            ? "legacy pi.perf.ui-metrics.v2 is still active; restart before installing v3"
            : "incompatible object already owns pi.perf.ui-metrics.v3",
        }),
        snapshot: () => ({ at: Date.now(), metrics: [], owners: [] }),
        reset: () => {},
      };
    return {
      api: unavailable,
      observers: new Map(),
      nextObserverId: 1,
      samples: new Map(),
      status: {
        requestRender: false,
        doRender: false,
        handleTerminalInput: false,
        detail: compatible ? "another v3 provider owns the registry" : legacyPresent ? "legacy v2 wrapper detected" : "protocol conflict",
      },
      enabled: false,
      enabledOwners: new Set(),
      providerOwners: new Set(),
      requestOwners: new WeakSet(),
      renderOwners: new WeakSet(),
      inputOwners: new WeakSet(),
      renderStates: new WeakMap(),
    };
  }
  let value: RegistryState;
  {
    const state = {
      observers: new Map(),
      nextObserverId: 1,
      samples: new Map(),
      status: {
        requestRender: false,
        doRender: false,
        handleTerminalInput: false,
        detail: "provider has not attached a TUI",
      },
      enabled: false,
      enabledOwners: new Set(),
      providerOwners: new Set(),
      requestOwners: new WeakSet(),
      renderOwners: new WeakSet(),
      inputOwners: new WeakSet(),
      renderStates: new WeakMap(),
    } as Omit<RegistryState, "api">;
    const api: UiObservabilityRegistryV3 = {
      version: 3,
      acquire(owner, observer) {
        const id = state.nextObserverId++;
        state.observers.set(id, { owner, observer });
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          state.observers.delete(id);
        };
      },
      getStatus() {
        return {
          ...state.status,
          ...(observerFailures.length ? { detail: observerFailures.join("; ") } : {}),
          provider: "pi-perf",
          enabled: state.enabled,
          subscribers: state.observers.size,
        };
      },
      snapshot() {
        const metrics = [...state.samples].map(([name, recent]) => {
          const sorted = [...recent].sort((a, b) => a - b);
          return {
            name,
            count: recent.length,
            lastMs: recent.at(-1) ?? 0,
            p50Ms: percentile(sorted, 50),
            p95Ms: percentile(sorted, 95),
            maxMs: sorted.at(-1) ?? 0,
          };
        });
        return {
          at: Date.now(),
          metrics,
          owners: [...new Set([...state.observers.values()].map(({ owner }) => owner))].sort(),
          ...(state.runtime ? { runtime: { ...state.runtime } } : {}),
        };
      },
	  reset(owner) {
		// Samples are provider-owned. A consumer may clear its own local view,
		// but cannot erase measurements shared with every other subscriber.
		if (owner !== undefined && !state.providerOwners.has(owner)) return;
        state.samples.clear();
      },
      setEnabled(enabled, owner = "pi-perf") {
		state.providerOwners.add(owner);
        if (enabled) state.enabledOwners.add(owner);
        else state.enabledOwners.delete(owner);
        state.enabled = state.enabledOwners.size > 0;
      },
      updateRuntime(runtime) {
        state.runtime = { ...runtime };
      },
    };
    value = { ...state, api };
    // Methods close over `state`; keep all mutable collections shared between it and value.
    Object.defineProperties(value, {
      nextObserverId: {
        get: () => state.nextObserverId,
        set: (next: number) => { state.nextObserverId = next; },
        enumerable: true,
      },
      enabled: {
        get: () => state.enabled,
        set: (next: boolean) => { state.enabled = next; },
        enumerable: true,
      },
      status: {
        get: () => state.status,
        set: (next: UiInstrumentationStatus) => { state.status = next; },
        enumerable: true,
      },
    });
    ownedRegistry = value;
    // The symbol is a public protocol boundary. Never leak the provider's
    // mutable implementation state through it.
    host[UI_OBSERVABILITY_KEY] = api;
  }
  return value;
}

export function getUiObservabilityRegistry(): UiObservabilityRegistryV3 {
  return registry().api;
}

function observers(): UiMetricObserver[] {
  const reg = registry();
  if (!reg.enabled) return [];
  return [...reg.observers.values()].map(({ observer }) => observer);
}

const failedMethods = new WeakMap<UiMetricObserver, Set<keyof UiMetricObserver>>();
const observerFailures: string[] = [];
export function uiObserverDiagnostics(): readonly string[] { return [...observerFailures]; }
/** The instrumentation itself is an untrusted host callback too. Neither its
 * getters nor bookkeeping may prevent the original call or replace its error. */
export function protectInstrumentation<T>(label: string, call: () => T): T | undefined {
  try { return call(); } catch (error) {
    const diagnostic = `instrumentation.${label} failed (${error instanceof Error ? error.name : "unknown"})`;
    if (!observerFailures.includes(diagnostic)) {
      if (observerFailures.length === 16) observerFailures.shift();
      observerFailures.push(diagnostic);
    }
    return undefined;
  }
}
function observe<T>(observer: UiMetricObserver, method: keyof UiMetricObserver, call: () => T): T | undefined {
  if (failedMethods.get(observer)?.has(method)) return undefined;
  try { return call(); } catch (error) {
    let failed = failedMethods.get(observer);
    if (!failed) { failed = new Set(); failedMethods.set(observer, failed); }
    failed.add(method);
    const diagnostic = `observer.${method} failed (${error instanceof Error ? error.name : "unknown"}); callback quarantined`;
    if (!observerFailures.includes(diagnostic)) {
      if (observerFailures.length === 16) observerFailures.shift();
      observerFailures.push(diagnostic);
    }
    return undefined;
  }
}
function now(): number | undefined {
  const active = observers();
  if (!active.length) return undefined;
  for (const observer of active) {
    const at = observe(observer, "now", () => {
      const value = observer.now();
      if (!Number.isFinite(value)) throw new TypeError("non-finite clock");
      return value;
    });
    if (at !== undefined) return at;
  }
  return performance.now();
}

/** Publish a provider-owned semantic metric into the shared bounded snapshot. */
export function publishUiMetric(name: string, ms: number, detail?: UiMetricDetail): void {
  const reg = registry();
  const samples = reg.samples.get(name) ?? [];
  samples.push(ms);
  if (samples.length > SAMPLE_WINDOW) samples.shift();
  reg.samples.set(name, samples);
  for (const observer of observers()) observe(observer, "record", () => observer.record(name, ms, detail));
}
function painted(at: number): void {
  for (const observer of observers()) observe(observer, "painted", () => observer.painted(at));
}
function terminalInput(data: string, at: number, detail?: UiMetricDetail): void {
  for (const observer of observers()) observe(observer, "terminalInput", () => observer.terminalInput?.(data, at, detail));
}
function inputHandled(data: string, startedAt: number, finishedAt: number, detail?: UiMetricDetail): void {
  for (const observer of observers()) observe(observer, "inputHandled", () => observer.inputHandled?.(data, startedAt, finishedAt, detail));
}

const SUBMIT_INPUT = /^(?:\r|\n|\x1b\[13(?:;\d+(?::\d+)?)?u)$/;
const KITTY_KEY = /^\x1b\[(\d+)(?:;\d+(?::\d+)?)?u$/;
const BRACKETED_PASTE = /\x1b\[(?:200|201)~/;

/** Classify only what the latency report can interpret without ambiguity. */
export function classifyInputAction(data: string): InputActionKind {
  if (SUBMIT_INPUT.test(data)) return "submit";
  if (!data || BRACKETED_PASTE.test(data)) return "other";
  const kitty = data.match(KITTY_KEY);
  if (kitty) {
    const codepoint = Number(kitty[1]);
    return Number.isInteger(codepoint) && codepoint >= 32 && codepoint !== 127
      ? "typing"
      : "other";
  }
  // Plain UTF-8 text may arrive as more than one codepoint in one terminal
  // chunk. Controls and escape sequences are editor/navigation actions.
  return [...data].every((character) => {
    const codepoint = character.codePointAt(0) ?? 0;
    return codepoint >= 32 && codepoint !== 127;
  }) ? "typing" : "other";
}

function inputDetail(
  kind: InputActionKind,
  action: PendingInputAction,
): UiMetricDetail {
  return {
    inputKind: kind,
    interaction: action.interaction,
    bytes: action.bytes,
    characters: action.characters,
    ...(action.overlayClosed !== undefined ? { overlayClosed: action.overlayClosed } : {}),
    ...(action.inputContext ? { inputContext: action.inputContext } : {}),
    ...(action.coalesced > 1 ? { coalesced: action.coalesced } : {}),
  };
}

function hasVisibleOverlay(target: object): boolean {
  const candidate = Reflect.get(target, "hasOverlay") as (() => boolean) | undefined;
  if (typeof candidate !== "function") return false;
  try {
    return Reflect.apply(candidate, target, []) === true;
  } catch {
    return false;
  }
}

function requestMetric(kind: InputActionKind): string {
  if (kind === "typing") return "typing→request";
  if (kind === "overlay") return "overlay-enter→request";
  return "submit-key→request";
}

function paintMetric(kind: InputActionKind, action: PendingInputAction): string {
  if (kind === "typing") return "typing→paint";
  if (kind === "overlay") return action.overlayClosed ? "overlay-close→paint" : "overlay-enter→paint";
  return "submit-key→paint";
}

function handlerMetric(kind: InputActionKind, action: PendingInputAction): string {
  if (kind === "typing") return "typing-handler";
  if (kind === "overlay") return action.overlayClosed ? "overlay-close-handler" : "overlay-enter-handler";
  return "submit-handler";
}

function beginInputAction(
  target: object,
  kind: InputActionKind,
  data: string,
  at: number,
): PendingInputAction | undefined {
  if (kind === "other") return undefined;
  const state = stateFor(target);
  state.inputActions ??= new Map();
  const existing = state.inputActions.get(kind);
  if (existing) {
    existing.coalesced++;
    existing.bytes += Buffer.byteLength(data);
    existing.characters += [...data].length;
    return existing;
  }
  const action: PendingInputAction = {
    interaction: nextInputInteraction++,
    startedAt: at,
    coalesced: 1,
    bytes: Buffer.byteLength(data),
    characters: [...data].length,
    ...(currentInputContext ? { inputContext: currentInputContext } : {}),
  };
  state.inputActions.set(kind, action);
  return action;
}

function findMethodOwner(target: object, name: string): object | undefined {
  let value: object | null = target;
  while (value) {
    if (Object.prototype.hasOwnProperty.call(value, name)) {
      return typeof Reflect.get(value, name) === "function" ? value : undefined;
    }
    value = Reflect.getPrototypeOf(value) as object | null;
  }
  return undefined;
}

function stateFor(target: object): RenderState {
  const reg = registry();
  let state = reg.renderStates.get(target);
  if (!state) {
    state = {};
    reg.renderStates.set(target, state);
  }
  return state;
}

function readDimensions(target: object): TerminalDimensions | undefined {
  const terminal = Reflect.get(target, "terminal") as { columns?: unknown; rows?: unknown } | undefined;
  const columns = terminal?.columns;
  const rows = terminal?.rows;
  if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0) return undefined;
  if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) return undefined;
  return { columns, rows };
}

function resizeDetail(burst: ResizeBurst): UiMetricDetail {
  return {
    interaction: burst.interaction,
    changes: burst.changes,
    frames: burst.frames,
    fullRedraws: burst.fullRedraws,
    fromColumns: burst.from.columns,
    fromRows: burst.from.rows,
    toColumns: burst.to.columns,
    toRows: burst.to.rows,
  };
}

function scheduleResizeSettlement(state: RenderState, burst: ResizeBurst): void {
  if (burst.settleTimer) clearTimeout(burst.settleTimer);
  burst.settleTimer = setTimeout(() => {
    protectInstrumentation("resize.settle", () => {
      burst.settleTimer = undefined;
      if (state.resizeBurst !== burst) return;
      const reg = registry();
      if (!reg.enabled) {
        state.resizeBurst = undefined;
        return;
      }
      if (burst.lastPaintAt === undefined || burst.lastPaintAt < burst.lastChangeAt) {
        scheduleResizeSettlement(state, burst);
        return;
      }
      publishUiMetric(
        "resize-burst→settled",
        Math.max(0, burst.lastPaintAt - burst.startedAt),
        resizeDetail(burst),
      );
      state.resizeBurst = undefined;
    });
  }, RESIZE_SETTLE_MS);
  burst.settleTimer.unref?.();
}

function observeDimensions(target: object, state: RenderState, at: number): void {
  const next = readDimensions(target);
  if (!next) return;
  const previous = state.dimensions;
  state.dimensions = next;
  if (!previous || (previous.columns === next.columns && previous.rows === next.rows)) return;

  let burst = state.resizeBurst;
  if (!burst) {
    burst = {
      interaction: nextResizeInteraction++,
      startedAt: at,
      lastChangeAt: at,
      changes: 0,
      frames: 0,
      fullRedraws: 0,
      from: previous,
      to: next,
    };
    state.resizeBurst = burst;
  }
  burst.lastChangeAt = at;
  burst.lastPaintAt = undefined;
  burst.changes++;
  burst.to = next;
  state.resizePendingAt = at;
  scheduleResizeSettlement(state, burst);
}

function patchRequestRender(owner: object): boolean {
  const reg = registry();
  if (reg.requestOwners.has(owner)) return true;
  const original = Reflect.get(owner, "requestRender") as ((force?: boolean) => void) | undefined;
  if (typeof original !== "function") return false;

  const wrapped = function measuredRequestRender(this: object, force?: boolean) {
    protectInstrumentation("requestRender", () => {
      const started = now();
      if (started !== undefined) {
        const state = stateFor(this);
        observeDimensions(this, state, started);
        state.requestedAt ??= started;
        for (const [kind, action] of state.inputActions ?? []) {
          if (action.requestedAt !== undefined) continue;
          action.requestedAt = started;
          publishUiMetric(
            requestMetric(kind),
            Math.max(0, started - action.startedAt),
            inputDetail(kind, action),
          );
        }
      }
    });
    return Reflect.apply(original, this, [force]);
  };
  if (!Reflect.set(owner, "requestRender", wrapped) || Reflect.get(owner, "requestRender") !== wrapped) return false;
  reg.requestOwners.add(owner);
  return true;
}

function patchDoRender(owner: object): boolean {
  const reg = registry();
  if (reg.renderOwners.has(owner)) return true;
  const original = Reflect.get(owner, "doRender") as (() => void) | undefined;
  if (typeof original !== "function") return false;

  const wrapped = function measuredDoRender(this: object) {
    const measurement = protectInstrumentation("doRender.begin", () => {
      const started = now();
      if (started === undefined) return undefined;

      const state = stateFor(this);
      const requestedAt = state.requestedAt;
      state.requestedAt = undefined;
      const startedAt = started;
      const redrawsBefore = Number(Reflect.get(this, "fullRedraws") ?? 0);
      return { state, requestedAt, startedAt, redrawsBefore };
    });
    if (!measurement) return Reflect.apply(original, this, []);
    const { state, requestedAt, startedAt, redrawsBefore } = measurement;
    try {
      return Reflect.apply(original, this, []);
    } finally {
      const paintedAt = protectInstrumentation("doRender.clock", () => now() ?? startedAt) ?? startedAt;
      protectInstrumentation("doRender.end", () => {
        const redrawsAfter = Number(Reflect.get(this, "fullRedraws") ?? redrawsBefore);
        const mode = String(Reflect.get(this, "mode") ?? "unknown");
        const detail = { mode, fullRedraw: redrawsAfter > redrawsBefore };
        publishUiMetric("render", Math.max(0, paintedAt - startedAt), detail);
        if (requestedAt !== undefined) {
          publishUiMetric("ui-request→paint", Math.max(0, paintedAt - requestedAt), detail);
        }
        const resizePendingAt = state.resizePendingAt;
        const resizeBurst = state.resizeBurst;
        if (resizePendingAt !== undefined && resizeBurst) {
          state.resizePendingAt = undefined;
          resizeBurst.lastPaintAt = paintedAt;
          resizeBurst.frames++;
          if (detail.fullRedraw) resizeBurst.fullRedraws++;
          const resizeFrameDetail = { ...detail, ...resizeDetail(resizeBurst) };
          publishUiMetric("resize-render", Math.max(0, paintedAt - startedAt), resizeFrameDetail);
          publishUiMetric("resize→paint", Math.max(0, paintedAt - resizePendingAt), resizeFrameDetail);
        }
        for (const [kind, action] of state.inputActions ?? []) {
          publishUiMetric(
            paintMetric(kind, action),
            Math.max(0, paintedAt - action.startedAt),
            { ...detail, ...inputDetail(kind, action) },
          );
        }
      });
      protectInstrumentation("doRender.clearInput", () => state.inputActions?.clear());
      protectInstrumentation("doRender.painted", () => painted(paintedAt));
    }
  };
  if (!Reflect.set(owner, "doRender", wrapped) || Reflect.get(owner, "doRender") !== wrapped) return false;
  reg.renderOwners.add(owner);
  return true;
}

function patchTerminalInput(owner: object): boolean {
  const reg = registry();
  if (reg.inputOwners.has(owner)) return true;
  const original = Reflect.get(owner, "handleTerminalInput") as ((data: string) => void) | undefined;
  if (typeof original !== "function") return false;
  const wrapped = function measuredTerminalInput(this: object, data: string) {
    const measurement = protectInstrumentation("input.begin", () => {
      const at = now();
      if (at === undefined) return undefined;
      const classified = classifyInputAction(data);
      const overlayWasVisible = classified === "submit" && hasVisibleOverlay(this);
      const semanticOverlay = classified === "submit" && currentInputContext !== undefined;
      const kind: InputActionKind = overlayWasVisible || semanticOverlay ? "overlay" : classified;
      const action = beginInputAction(this, kind, data, at);
      terminalInput(data, at, action ? inputDetail(kind, action) : { inputKind: kind });
      return { at, action, kind, overlayWasVisible };
    });
    if (!measurement) return Reflect.apply(original, this, [data]);
    const { at, action, kind, overlayWasVisible } = measurement;
    try {
      return Reflect.apply(original, this, [data]);
    } finally {
      protectInstrumentation("input.end", () => {
        if (action) {
          const finishedAt = now() ?? at;
          if (kind === "overlay") {
            action.overlayClosed = overlayWasVisible && !hasVisibleOverlay(this);
          }
          const detail = inputDetail(kind, action);
          inputHandled(data, at, finishedAt, detail);
          publishUiMetric(
            handlerMetric(kind, action),
            Math.max(0, finishedAt - at),
            detail,
          );
        }
      });
    }
  };
  if (!Reflect.set(owner, "handleTerminalInput", wrapped) || Reflect.get(owner, "handleTerminalInput") !== wrapped) return false;
  reg.inputOwners.add(owner);
  return true;
}

/** Install once on the live renderer's actual prototype chain. */
export function installUiInstrumentation(tui: TUI, observer: UiMetricObserver): UiInstrumentationStatus {
  const reg = registry();
  // A reloaded module sees the stable v3 API published by the previous module
  // instance. Its prototype wrappers are intentionally permanent, so joining
  // that provider as a new observer is both cheaper and safer than trying to
  // wrap the same live TUI again.
  if (reg.status.detail === "another v3 provider owns the registry") {
    const status = reg.api.getStatus();
    releaseByObserver.get(observer)?.();
    releaseByObserver.set(observer, reg.api.acquire("pi-perf", observer));
    return {
      requestRender: status.requestRender,
      doRender: status.doRender,
      handleTerminalInput: status.handleTerminalInput,
      ...(status.detail ? { detail: status.detail } : {}),
    };
  }
  if (!reg.enabled) {
    return { requestRender: false, doRender: false, handleTerminalInput: false, detail: "provider disabled" };
  }
  try {
    const requestOwner = findMethodOwner(tui, "requestRender");
    const renderOwner = findMethodOwner(tui, "doRender");
    const inputOwner = findMethodOwner(tui, "handleTerminalInput");
    const requestRender = requestOwner ? patchRequestRender(requestOwner) : false;
    const doRender = renderOwner ? patchDoRender(renderOwner) : false;
    const handleTerminalInput = inputOwner ? patchTerminalInput(inputOwner) : false;
    stateFor(tui).dimensions = readDimensions(tui);
    const status = {
      requestRender,
      doRender,
      handleTerminalInput,
      detail: doRender ? undefined : "live TUI has no callable doRender method",
    };
    reg.status = status;
    releaseByObserver.get(observer)?.();
    releaseByObserver.set(observer, reg.api.acquire("pi-perf", observer));
    return status;
  } catch (error) {
    const status = {
      requestRender: false,
      doRender: false,
      handleTerminalInput: false,
      detail: error instanceof Error ? error.message : String(error),
    };
    reg.status = status;
    releaseByObserver.get(observer)?.();
    releaseByObserver.set(observer, reg.api.acquire("pi-perf", observer));
    return status;
  }
}

const releaseByObserver = new WeakMap<UiMetricObserver, () => void>();

/** Stop reporting without undoing a shared prototype wrapper. */
export function deactivateUiInstrumentation(observer: UiMetricObserver): void {
  releaseByObserver.get(observer)?.();
  releaseByObserver.delete(observer);
}

interface PendingMark {
  startedAt: number;
  detail?: UiMetricDetail;
  coalesced: number;
}

/** Correlates semantic events with the next completed TUI frame. */
export class PaintMarks {
  private readonly pending = new Map<string, PendingMark>();
  private readonly now: () => number;
  private readonly recordMetric: UiMetricObserver["record"];

  constructor(recordMetric: UiMetricObserver["record"], now: () => number) {
    this.recordMetric = recordMetric;
    this.now = now;
  }

  mark(name: string, detail?: UiMetricDetail, startedAt: number = this.now()): void {
    const existing = this.pending.get(name);
    if (existing) {
      existing.coalesced += 1;
      return;
    }
    this.pending.set(name, { startedAt, detail, coalesced: 1 });
  }

  painted(at: number): void {
    for (const [name, mark] of this.pending) {
      this.pending.delete(name);
      this.recordMetric(name, Math.max(0, at - mark.startedAt), {
        ...mark.detail,
        ...(mark.coalesced > 1 ? { coalesced: mark.coalesced } : {}),
      });
    }
  }

  reset(): void {
    this.pending.clear();
  }
}
