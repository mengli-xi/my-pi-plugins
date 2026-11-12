import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
/**
 * pi-perf — interaction latency, frame stalls, event-loop health, and memory.
 *
 * The useful boundary is not "how long did the model take". It is the gap
 * between an action/event and the frame that makes it visible. This extension
 * instruments that boundary and keeps provider/tool timing out of the report.
 */

import { isAbsolute, join } from "node:path";
import { PerfConfig, sampleInterval, sampleThreshold } from "./src/config.ts";
import { PerfHistory, packageHash, trendText, type Identity } from "./src/history.ts";
import { LowFrequencySampler } from "./src/sampler.ts";
import { extensionArguments, processPackageInventory } from "./src/packages.ts";
import { firstObservedFrame } from "./src/first-observed-frame.ts";
const extensionReachedMs = performance.now();
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { openPerfReport, writePerfReport, type PerfReportData } from "./src/html-report.ts";
import {
  claimHostCapabilityWarning,
  readHostReloadCacheStatus,
  readHostSessionReplacementGcMetrics,
} from "./src/host-capabilities.ts";
import { JsonlWriter } from "./src/log-writer.ts";
import { formatBytes, formatDelta, MemoryTracker, type MemoryPoint, type MemorySummary } from "./src/runtime-metrics.ts";
import { acquirePerfRuntimeOwnership } from "./src/runtime-ownership.ts";
import { formatMs, SpanRecorder, type SpanStats } from "./src/spans.ts";
import { resolveStartupBoundaries } from "./src/startup-metrics.ts";
import {
  getTelemetryRegistry,
  type TelemetryMetricStats,
  type TelemetrySample,
  type TelemetrySnapshot,
} from "./src/telemetry.ts";
import { PerfTimeline } from "./src/timeline.ts";
import {
  uiObserverDiagnostics,
  deactivateUiInstrumentation,
  getUiObservabilityRegistry,
  installUiInstrumentation,
  PaintMarks,
  publishUiMetric,
  setUiInputContext,
  type UiInstrumentationStatus,
  type UiMetricDetail,
  type UiMetricObserver,
} from "./src/ui-metrics.ts";

// 不能放在 agent 根目录：pi 启动时的 migrateSessionsFromAgentRoot 会把根目录下每个 .jsonl
// 整个读进内存看第一行，这个日志攒到几百 MB 后每个 pi 进程（含 subagent child）启动都多花 0.3 s。
const LOG_THRESHOLD_MS = sampleThreshold(process.env.PI_PERF_LOG_MS, 50);
const LOOP_STALL_MS = sampleThreshold(process.env.PI_PERF_LOOP_STALL_MS, 50);
const MEMORY_SAMPLE_MS = sampleInterval(process.env.PI_PERF_MEMORY_SAMPLE_MS, 10_000);
const MEMORY_LOG_MS = sampleThreshold(process.env.PI_PERF_MEMORY_LOG_MS, 60_000);
const LOOP_SAMPLE_MS = 250;
const TIMELINE_CAPACITY = 10_000;
const WIDGET_KEY = "pi-perf:frame-probe";
const STARTUP_OBSERVED_FRAME_KEY = Symbol.for("pi.perf.startup-observed-frame.v1");

interface StartupObservedFrameState {
  version: 1;
  completed: boolean;
  readyRecorded?: boolean;
}

function startupObservedFrameState(): StartupObservedFrameState {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = (host[STARTUP_OBSERVED_FRAME_KEY] ?? host[Symbol.for("pi.perf.startup-first-paint.v1")]) as Partial<StartupObservedFrameState> | undefined;
  if (existing?.version === 1 && typeof existing.completed === "boolean") {
    host[STARTUP_OBSERVED_FRAME_KEY] = existing;
    return existing as StartupObservedFrameState;
  }
  const state: StartupObservedFrameState = { version: 1, completed: false };
  host[STARTUP_OBSERVED_FRAME_KEY] = state;
  return state;
}

const METRIC_ORDER = [
  "launcher→first-observed-frame",
  "process-start→first-observed-frame",
  "typing-handler",
  "typing→request",
  "typing→paint",
  "overlay-enter-handler",
  "overlay-enter→request",
  "overlay-enter→paint",
  "overlay-close-handler",
  "overlay-close→paint",
  "questionnaire-submit-handler",
  "questionnaire-submit→tool-resume",
  "questionnaire-submit→paint",
  "resize-render",
  "resize→paint",
  "resize-burst→settled",
  "submit-handler",
  "submit-key→request",
  "submit-key→input-event",
  "input-event→agent-start",
  "submit-key→agent-start",
  "submit-key→paint",
  "submit→spinner",
  "submit→paint",
  "terminal-input→paint",
  "input-event→paint",
  "agent-start→spinner",
  "message-start→paint",
  "message-update→paint",
  "message-end→paint",
  "tool-start→paint",
  "tool-update→paint",
  "tool-end→paint",
  "ui-request→paint",
  "render",
  "event-loop-stall",
];

type LatencyStats = Omit<SpanStats, "totalMs">;

function ordered<T extends LatencyStats>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const li = METRIC_ORDER.indexOf(left.name);
    const ri = METRIC_ORDER.indexOf(right.name);
    if (li === -1 && ri === -1) return left.name.localeCompare(right.name);
    if (li === -1) return 1;
    if (ri === -1) return -1;
    return li - ri;
  });
}

function latencyTable(rows: LatencyStats[], preserveOrder = false): string {
  if (rows.length === 0) return "还没有完成的交互帧。";
  const width = Math.max(6, ...rows.map((row) => row.name.length));
  const header = `${"metric".padEnd(width)}  ${"n".padStart(5)}  ${"last".padStart(8)}  ${"p50".padStart(8)}  ${"p95".padStart(8)}  ${"max".padStart(8)}`;
  const lines = (preserveOrder ? rows : ordered(rows)).map((row) =>
    `${row.name.padEnd(width)}  ${String(row.count).padStart(5)}  ` +
    `${formatMs(row.lastMs).padStart(8)}  ${formatMs(row.p50Ms).padStart(8)}  ` +
    `${formatMs(row.p95Ms).padStart(8)}  ${formatMs(row.maxMs).padStart(8)}`,
  );
  return [header, "-".repeat(header.length), ...lines].join("\n");
}

function pluginRows(rows: TelemetryMetricStats[], limit?: number): LatencyStats[] {
  const sorted = [...rows].sort((left, right) => right.p95Ms - left.p95Ms || right.maxMs - left.maxMs);
  return (limit === undefined ? sorted : sorted.slice(0, limit)).map((row) => ({
    name: `${row.owner}/${row.name}`,
    count: row.count,
    lastMs: row.lastMs,
    p50Ms: row.p50Ms,
    p95Ms: row.p95Ms,
    maxMs: row.maxMs,
  }));
}

function pluginSignals(snapshot: TelemetrySnapshot): string {
  const observations = snapshot.observations.map((row) =>
    `${row.owner}/${row.name}  n=${row.count} last=${row.last.toFixed(1)}${row.unit} p95=${row.p95.toFixed(1)}${row.unit} max=${row.max.toFixed(1)}${row.unit}`
  );
  const gauges = snapshot.gauges.map((row) =>
    `${row.owner}/${row.name}  current=${row.value.toFixed(1)}${row.unit} peak=${row.peak.toFixed(1)}${row.unit}`
  );
  const counters = snapshot.counters.map((row) => `${row.owner}/${row.name}  n=${row.value}`);
  const all = [...observations, ...gauges, ...counters];
  const visible = all.slice(0, 60);
  if (all.length > visible.length) visible.push(`… ${all.length - visible.length} more; use a producer-filtered report for details`);
  return visible.join("\n") || "no samples";
}

function memoryReport(summary: MemorySummary): string {
  const rows: Array<[string, keyof Omit<MemorySummary["current"], "at">]> = [
    ["rss", "rss"],
    ["heap used", "heapUsed"],
    ["heap total", "heapTotal"],
    ["external", "external"],
    ["array buffers", "arrayBuffers"],
  ];
  const lines = rows.map(([label, key]) => {
    const current = summary.current[key];
    return `${label.padEnd(13)} ${formatBytes(current).padStart(9)}  Δ ${formatDelta(current - summary.start[key]).padStart(9)}  peak ${formatBytes(summary.peak[key]).padStart(9)}`;
  });
  return lines.join("\n");
}

function isSubmitInput(data: string): boolean {
  return data === "\r" || data === "\n" || /^\x1b\[13(?:;\d+(?::\d+)?)?u$/.test(data);
}

function roleOf(event: { message?: { role?: unknown } }): string | undefined {
  const role = event.message?.role;
  return typeof role === "string" ? role : undefined;
}

const PERF_COMMANDS = ["on", "off", "reset", "log", "memory", "top", "export", "open", "7d", "30d"] as const;

export function perfArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const query = prefix.trim().toLowerCase();
  const matches = PERF_COMMANDS.filter((value) => query !== value && value.startsWith(query))
    .map((value) => ({ value, label: value }));
  return matches.length > 0 ? matches : null;
}

export default function piPerf(pi: ExtensionAPI): void {
  const LOG_PATH = join(getAgentDir(), "perf", "ui.jsonl");
  const spans = new SpanRecorder(() => performance.now());
  const memory = new MemoryTracker();
  const timeline = new PerfTimeline(TIMELINE_CAPACITY);
  const writer = new JsonlWriter(LOG_PATH);
  const sharedRegistry = getUiObservabilityRegistry();
  const telemetryRegistry = getTelemetryRegistry();
  const startupBoundaries = resolveStartupBoundaries();
  const startupState = startupObservedFrameState();
  let startupFramePending = false;
  let startupMarksInstalled = false;
  const providerOwner = "pi-perf";
  const config = new PerfConfig(getAgentDir());
  const identity: Identity = { pid: process.pid, piVersion: VERSION, packagesHash: packageHash([]), packages: [], mode: "unknown" };
  const history = new PerfHistory(join(getAgentDir(), "perf"), identity);
  let stopMaintenance: (() => void) | undefined;
  let packageResolution: Promise<void> | undefined;
  let packageInventoryError: string | undefined;
  let samplingEnabled = config.enabled && !["0", "false", "off"].includes((process.env.PI_PERF_ENABLED ?? "1").toLowerCase());
  // Fine-grained probes are opt-in and never persisted across process starts.
  let enabled = false;
  let loopTimer: NodeJS.Timeout | undefined;
  let telemetryUnsubscribe: (() => void) | undefined;
  let lastContext: ExtensionContext | undefined;
  let releaseObservedFrame: (() => void) | undefined;
  const sampler = new LowFrequencySampler(sample => history.write("sample", sample), () => {
    const ctx = lastContext;
    if (!ctx) return {};
    const tokens = ctx.getContextUsage()?.tokens;
    return { entries: ctx.sessionManager.getEntries().length, ...(tokens != null ? { contextTokens: tokens } : {}) };
  }, 60_000, () => memory.sample());
  let eluStart = performance.eventLoopUtilization();
  let sessionId = "";
  let lastEnterAt: number | undefined;
  let lastEnterInteraction: number | undefined;
  let lastSubmitAt: number | undefined;
  let lastSubmitInteraction: number | undefined;
  let lastInputEventAt: number | undefined;
  let lastHostGcCount = 0;
  const activeQuestionnaires = new Set<string>();
  let pendingQuestionnaireSubmit: {
    startedAt: number;
    handlerMs: number;
    interaction?: number;
    toolCallId: string;
    detail: UiMetricDetail;
    confirmed: boolean;
    paintMs?: number;
  } | undefined;
  let inputUnsubscribe: (() => void) | undefined;
  let uiStatus: UiInstrumentationStatus = {
    requestRender: false,
    doRender: false,
    handleTerminalInput: false,
    detail: "TUI has not been attached yet",
  };
  const disposeBlocked = pi.events.on("rpiv:ask-user:blocked", (payload) => {
    if (retired) return;
    const active = (payload as { active?: unknown } | undefined)?.active === true;
    setUiInputContext(active ? "questionnaire" : undefined);
  });

  const logMemoryFields = () => {
    const current = memory.snapshot().current;
    return {
      rssBytes: current.rss,
      heapUsedBytes: current.heapUsed,
      externalBytes: current.external,
      arrayBuffersBytes: current.arrayBuffers,
    };
  };

  const recordMetric = (name: string, ms: number, detail?: UiMetricDetail): void => {
    if (!enabled) return;
    spans.record(name, ms);
    timeline.add({
      source: "ui",
      owner: "pi",
      metric: name,
      value: ms,
      unit: "ms",
      interaction: typeof detail?.interaction === "number" ? detail.interaction : undefined,
      attributes: detail,
    });
    if (
      (name === "overlay-close→paint" || name === "overlay-enter→paint") &&
      pendingQuestionnaireSubmit &&
      (pendingQuestionnaireSubmit.interaction === undefined ||
        detail?.interaction === pendingQuestionnaireSubmit.interaction)
    ) {
      if (pendingQuestionnaireSubmit.confirmed) {
        const questionnaire = pendingQuestionnaireSubmit;
        pendingQuestionnaireSubmit = undefined;
        publishUiMetric("questionnaire-submit→paint", ms, {
          ...detail,
          toolCallId: questionnaire.toolCallId,
        });
      } else {
        pendingQuestionnaireSubmit.paintMs = ms;
      }
    }
    if (ms < LOG_THRESHOLD_MS) return;
    writer.write({
      ...identity,
      at: new Date().toISOString(),
      kind: "latency",
      session: sessionId,
      metric: name,
      ms,
      ...detail,
      memory: logMemoryFields(),
    });
  };

  const recordTelemetry = (sample: TelemetrySample): void => {
    if (!enabled) return;
    timeline.add({
      source: "plugin",
      owner: sample.owner,
      metric: sample.name,
      value: sample.value,
      unit: sample.unit,
      interaction: typeof sample.attributes?.interaction === "number" ? sample.attributes.interaction : undefined,
      attributes: { kind: sample.kind, ...sample.attributes },
    });
    if (sample.kind !== "measure" || !sample.logEnabled || sample.value < sample.slowSampleMs) return;
    writer.write({
      ...identity,
      at: new Date().toISOString(),
      kind: "plugin-latency",
      session: sessionId,
      owner: sample.owner,
      metric: sample.name,
      ms: sample.value,
      ...(sample.attributes ? { attributes: sample.attributes } : {}),
      memory: logMemoryFields(),
    });
  };

  const marks = new PaintMarks(publishUiMetric, () => performance.now());

  const eventLoopSnapshot = () => {
    const elu = performance.eventLoopUtilization(eluStart);
    return { ...sampler.loopSnapshot(), utilization: elu.utilization };
  };

  const recordRuntime = (point: MemoryPoint): void => {
    const loop = eventLoopSnapshot();
    const rows: Array<[string, number, string]> = [
      ["memory.rss", point.rss, "bytes"],
      ["memory.heap-used", point.heapUsed, "bytes"],
      ["memory.heap-total", point.heapTotal, "bytes"],
      ["memory.external", point.external, "bytes"],
      ["memory.array-buffers", point.arrayBuffers, "bytes"],
      ["event-loop.delay-p95", loop.p95Ms, "ms"],
      ["event-loop.utilization", loop.utilization, "ratio"],
    ];
    for (const [metric, value, unit] of rows) {
      timeline.add({ at: point.at, source: "runtime", owner: "runtime", metric, value, unit });
    }
  };

  const updateSharedRuntime = (point?: MemoryPoint): void => {
    const current = point ?? memory.snapshot().current;
    const loop = eventLoopSnapshot();
    sharedRegistry.updateRuntime?.({
      at: current.at,
      rssBytes: current.rss,
      heapUsedBytes: current.heapUsed,
      externalBytes: current.external,
      arrayBuffersBytes: current.arrayBuffers,
      eventLoopUtilization: loop.utilization,
      eventLoopDelayP95Ms: loop.p95Ms,
    });
  };
  const handleTerminalInput = (
    data: string,
    at: number,
    detail?: UiMetricDetail,
  ): void => {
    // Ignore common terminal capability replies; they are not user actions.
    if (data.startsWith("\x1b]11;") || /^\x1b\[\??\d+(?:;\d+)*[ct]$/.test(data)) return;
    mark("terminal-input→paint", detail, at);
    if (isSubmitInput(data) && detail?.inputKind === "submit") {
      lastEnterAt = at;
      lastEnterInteraction = typeof detail?.interaction === "number"
        ? detail.interaction
        : undefined;
    }
  };
  const observer: UiMetricObserver = {
    now: () => performance.now(),
    record: recordMetric,
    painted: (at) => {
      marks.painted(at);
    },
    terminalInput: handleTerminalInput,
    inputHandled: (_data, startedAt, finishedAt, detail) => {
      if (detail?.inputKind !== "overlay" || detail.inputContext !== "questionnaire") return;
      const toolCallId = [...activeQuestionnaires].at(-1);
      if (!toolCallId) return;
      const interaction = typeof detail.interaction === "number" ? detail.interaction : undefined;
      pendingQuestionnaireSubmit = {
        startedAt,
        handlerMs: Math.max(0, finishedAt - startedAt),
        interaction,
        toolCallId,
        detail,
        confirmed: false,
      };
    },
  };

  const mark = (name: string, detail?: UiMetricDetail, startedAt?: number): void => {
    if (!retired && enabled && uiStatus.doRender) marks.mark(name, detail, startedAt);
  };

  let lastMemoryLog = 0;

  const detachUi = (): void => {
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    deactivateUiInstrumentation(observer);
    const ctx = lastContext;
    releaseObservedFrame?.();
    if (ctx?.mode === "tui") {
      try { ctx.ui.setWidget(WIDGET_KEY, undefined); } catch {}
    }
    uiStatus = {
      requestRender: false,
      doRender: false,
      handleTerminalInput: false,
      detail: enabled ? "TUI has not been attached yet" : "provider disabled",
    };
  };

  const attachUi = (ctx: ExtensionContext): void => {
    if ((!enabled && !startupFramePending) || !samplingEnabled || ctx.mode !== "tui") return;
    const availability = sharedRegistry.getStatus();
    if (availability.provider === "unavailable") {
      ctx.ui.notify(`pi-perf: ${availability.detail ?? "UI protocol conflict"}`, "warning");
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui: TUI): Component & { dispose(): void } => {
        releaseObservedFrame?.();
        if (enabled) {
          deactivateUiInstrumentation(observer);
          uiStatus = installUiInstrumentation(tui, observer);
        }
        if (startupFramePending) releaseObservedFrame = firstObservedFrame(tui, at => {
          if (!startupFramePending) return;
          startupFramePending = false;
          startupState.completed = true;
          history.write("startup", { firstObservedFrameMs: at, ...(startupBoundaries.launcherStartedAt !== undefined
            ? { launcherFirstObservedFrameMs: at - startupBoundaries.launcherStartedAt } : {}) });
        });
        if (!enabled) return { render: () => [], invalidate: () => {}, dispose: () => releaseObservedFrame?.() };
        if (!uiStatus.doRender) {
          ctx.ui.notify(`pi-perf: frame instrumentation unavailable (${uiStatus.detail ?? "unknown reason"})`, "warning");
        } else if (startupFramePending && !startupMarksInstalled) {
          startupMarksInstalled = true;
          marks.mark("process-start→first-observed-frame", { boundary: "process" }, startupBoundaries.processStartedAt);
          if (startupBoundaries.launcherStartedAt !== undefined) {
            marks.mark("launcher→first-observed-frame", { boundary: "launcher" }, startupBoundaries.launcherStartedAt);
          }
        }
        return {
          render: () => [],
          invalidate: () => {},
          dispose: () => deactivateUiInstrumentation(observer),
        };
      },
      { placement: "belowEditor" },
    );
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    if (enabled && !uiStatus.handleTerminalInput) {
      inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
        handleTerminalInput(data, performance.now(), {
          inputKind: "unknown",
        });
        return undefined;
      });
    }
  };

  const startRuntime = (): void => {
    if (enabled) return;
    enabled = true;
    sharedRegistry.setEnabled?.(true, providerOwner);
    telemetryRegistry.setEnabled(true, providerOwner);
    telemetryUnsubscribe ??= telemetryRegistry.acquireObserver(providerOwner, recordTelemetry);
    eluStart = performance.eventLoopUtilization();
    let expectedLoopTick = performance.now() + LOOP_SAMPLE_MS;
    loopTimer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - expectedLoopTick);
      expectedLoopTick = now + LOOP_SAMPLE_MS;
      if (lag >= LOOP_STALL_MS) publishUiMetric("event-loop-stall", lag);
    }, LOOP_SAMPLE_MS);
    loopTimer.unref();
    sampler.setDetail(MEMORY_SAMPLE_MS, point => {
      recordRuntime(point);
      updateSharedRuntime(point);
      if (point.at - lastMemoryLog < MEMORY_LOG_MS) return;
      lastMemoryLog = point.at;
      writer.write({ ...identity, at: new Date(point.at).toISOString(), kind: "memory", session: sessionId,
        rssBytes: point.rss, heapUsedBytes: point.heapUsed, heapTotalBytes: point.heapTotal,
        externalBytes: point.external, arrayBuffersBytes: point.arrayBuffers });
    });
    const point = memory.sample();
    recordRuntime(point);
    updateSharedRuntime(point);
    if (lastContext) attachUi(lastContext);
  };

  const stopRuntime = (): void => {
    enabled = false;
    sharedRegistry.setEnabled?.(false, providerOwner);
    telemetryRegistry.setEnabled(false, providerOwner);
    telemetryUnsubscribe?.();
    telemetryUnsubscribe = undefined;
    detachUi();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = undefined;
    sampler.setDetail();
  };

  let retired = false;
  let ownership: ReturnType<typeof acquirePerfRuntimeOwnership>;
  const retireRuntime = (): void => {
    if (retired) return;
    retired = true;
    sampler.stop();
    stopMaintenance?.();
    releaseObservedFrame?.();
    disposeBlocked?.();
    activeQuestionnaires.clear();
    pendingQuestionnaireSubmit = undefined;
    setUiInputContext(undefined);
    stopRuntime();
    lastContext = undefined;
    ownership.release();
    if (!packageResolution) {
      identity.packages = ["local"]; identity.packagesHash = packageHash(identity.packages);
      history.setIdentityReady(Promise.resolve());
    }
    void history.flush();
    void writer.flush();
  };
  ownership = acquirePerfRuntimeOwnership(retireRuntime);

  if (samplingEnabled) sampler.start();
  sharedRegistry.setEnabled?.(false, providerOwner);
  telemetryRegistry.setEnabled(false, providerOwner);

  const recordHostGcMetrics = (): void => {
    const hostGc = readHostSessionReplacementGcMetrics();
    if (!enabled || !hostGc || hostGc.count <= lastHostGcCount) return;
    lastHostGcCount = hostGc.count;
    const attributes = {
      count: hostGc.count,
      ...(hostGc.lastReason ? { reason: hostGc.lastReason } : {}),
    };
    const at = hostGc.lastAt || Date.now();
    timeline.add({ source: "runtime", owner: "host", metric: "session-replacement.gc-last", value: hostGc.lastMs, unit: "ms", at, attributes });
    timeline.add({ source: "runtime", owner: "host", metric: "session-replacement.gc-average", value: hostGc.totalMs / hostGc.count, unit: "ms", at, attributes });
    timeline.add({ source: "runtime", owner: "host", metric: "session-replacement.gc-max", value: hostGc.maxMs, unit: "ms", at, attributes });
    timeline.add({ source: "runtime", owner: "host", metric: "session-replacement.gc-count", value: hostGc.count, unit: "count", at, attributes });
  };

  const adoptContext = (ctx: ExtensionContext): void => {
    if (retired) return;
    lastContext = ctx;
    const hostWarning = claimHostCapabilityWarning(readHostReloadCacheStatus());
    if (hostWarning && ctx.mode === "tui") {
      ctx.ui.notify(`pi-perf: ${hostWarning}`, "warning");
    }
    recordHostGcMetrics();
    attachUi(ctx);
  };

  pi.on("session_start", (event, ctx) => {
    if (retired) return;
    const readyMs = performance.now();
    identity.mode = ctx.mode;
    if (ctx.mode === "tui") stopMaintenance ??= history.scheduleCleanup();
    else { stopMaintenance?.(); stopMaintenance = undefined; }
    if (!packageResolution) {
      const settings = pi.getSettings();
      const local = (settings.extensions?.length ?? 0) > 0 ||
        [...pi.getAllTools(), ...pi.getCommands()].some(item => item.sourceInfo.origin === "top-level" && !item.sourceInfo.path.startsWith("builtin:"));
      const roots = (settings.packages ?? []).map(value => {
        const source = typeof value === "string" ? value : value.source;
        // Effective settings lose user/project provenance. Do not resolve an
        // ambiguous relative settings path against the user's project cwd.
        return isAbsolute(source) || source.startsWith("npm:") ? source : "";
      });
      const sources = [...roots,
        ...extensionArguments(process.argv), ...(local ? [""] : [])];
      packageResolution = processPackageInventory(sources, process.cwd()).then(result => {
        identity.packages = result.names;
        identity.packagesHash = packageHash(result.names);
        identity.packageResolveMs = result.durationMs;
      }).catch(error => {
        packageInventoryError = `package inventory unavailable (${(error as Error).name})`;
        identity.packages = ["local"]; identity.packagesHash = packageHash(identity.packages);
        if (!retired) ctx.ui.notify(`pi-perf: package inventory unavailable (${(error as Error).name})`, "warning");
      });
      history.setIdentityReady(packageResolution);
    }
    startupFramePending = event.reason === "startup" && samplingEnabled && !startupState.completed;
    adoptContext(ctx);
    if (samplingEnabled) {
      history.write("session", {});
      if (event.reason === "startup" && !startupState.readyRecorded) {
        startupState.readyRecorded = true;
        history.write("startup", { readyMs, extensionReachedMs, extensionToReadyMs: readyMs - extensionReachedMs });
      }
    }
    try { sessionId = ctx.sessionManager.getSessionId(); } catch { sessionId = ""; }
  });

  pi.on("input", (event) => {
    if (event.source === "interactive") {
      const now = performance.now();
      const hasRawSubmit = lastEnterAt !== undefined && now - lastEnterAt <= 10_000;
      lastSubmitAt = hasRawSubmit ? lastEnterAt : now;
      lastSubmitInteraction = hasRawSubmit ? lastEnterInteraction : undefined;
      lastInputEventAt = now;
      if (enabled && hasRawSubmit && lastEnterAt !== undefined) {
        publishUiMetric(
          "submit-key→input-event",
          Math.max(0, now - lastEnterAt),
          { source: event.source, interaction: lastSubmitInteraction },
        );
      }
      lastEnterAt = undefined;
      lastEnterInteraction = undefined;
      const detail = {
        source: event.source,
        ...(lastSubmitInteraction !== undefined
          ? { interaction: lastSubmitInteraction }
          : {}),
      };
      mark("submit→paint", detail, lastSubmitAt);
      mark("input-event→paint", detail, now);
    }
    return { action: "continue" } as const;
  });

  pi.on("agent_start", () => {
    const now = performance.now();
    const detail = lastSubmitInteraction === undefined
      ? undefined
      : { interaction: lastSubmitInteraction };
    mark("agent-start→spinner", detail, now);
    if (
      enabled && lastInputEventAt !== undefined &&
      now - lastInputEventAt <= 30_000
    ) {
      publishUiMetric(
        "input-event→agent-start",
        Math.max(0, now - lastInputEventAt),
        detail,
      );
    }
    if (lastSubmitAt !== undefined && now - lastSubmitAt <= 30_000) {
      if (enabled) {
        publishUiMetric(
          "submit-key→agent-start",
          Math.max(0, now - lastSubmitAt),
          detail,
        );
      }
      mark("submit→spinner", detail, lastSubmitAt);
    }
    lastSubmitAt = undefined;
    lastSubmitInteraction = undefined;
    lastInputEventAt = undefined;
  });

  pi.on("message_start", (event) => mark("message-start→paint", { role: roleOf(event) }));
  pi.on("message_update", (event) => mark("message-update→paint", { role: roleOf(event) }));
  pi.on("message_end", (event) => mark("message-end→paint", { role: roleOf(event) }));
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === "ask_user_question") {
      activeQuestionnaires.add(event.toolCallId);
    }
    mark("tool-start→paint", { tool: event.toolName });
  });
  pi.on("tool_execution_update", (event) => mark("tool-update→paint", { tool: event.toolName }));
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "ask_user_question") {
      const submitted = pendingQuestionnaireSubmit;
      const cancelled = (event.result as { details?: { cancelled?: unknown } } | undefined)
        ?.details?.cancelled === true;
      if (submitted?.toolCallId === event.toolCallId && !event.isError && !cancelled) {
        submitted.confirmed = true;
        publishUiMetric("questionnaire-submit-handler", submitted.handlerMs, {
          ...submitted.detail,
          toolCallId: event.toolCallId,
        });
        publishUiMetric(
          "questionnaire-submit→tool-resume",
          Math.max(0, performance.now() - submitted.startedAt),
          {
            toolCallId: event.toolCallId,
            ...(submitted.interaction !== undefined ? { interaction: submitted.interaction } : {}),
          },
        );
        if (submitted.paintMs !== undefined) {
          publishUiMetric("questionnaire-submit→paint", submitted.paintMs, {
            ...submitted.detail,
            toolCallId: event.toolCallId,
          });
          pendingQuestionnaireSubmit = undefined;
        }
      } else if (submitted?.toolCallId === event.toolCallId) {
        pendingQuestionnaireSubmit = undefined;
      }
      activeQuestionnaires.delete(event.toolCallId);
    }
    mark("tool-end→paint", { tool: event.toolName });
  });

  pi.on("session_shutdown", async () => {
    retireRuntime();
    await writer.flush();
    await history.flush();
  });

  pi.registerCommand("perf", {
    description: "Show or export global performance (`top`, `export`, `open`, `reset`, `memory`, `log`)",
    getArgumentCompletions: perfArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (retired) return;
      const rawCommand = args.trim().toLowerCase();
      if (rawCommand && !PERF_COMMANDS.includes(rawCommand as typeof PERF_COMMANDS[number])) {
        ctx.ui.notify(`用法：/perf [${PERF_COMMANDS.join("|")}]`, "warning");
        return;
      }
      const command = rawCommand;
      await writer.flush();
      await history.flush();
      await history.loadMaintenanceErrors();
      const providerDiagnostic = sharedRegistry.getStatus().detail;
      const diagnostics = [config.error, writer.error, history.error, history.maintenanceError, history.identityError, packageInventoryError, sampler.error,
        ...((providerDiagnostic?.includes("observer.") || providerDiagnostic?.includes("instrumentation.")) ? [providerDiagnostic] : []), ...uiObserverDiagnostics()].filter(Boolean);
      if (diagnostics.length) ctx.ui.notify(`pi-perf: ${diagnostics.join("; ")}`, "warning");
      if (command === "on") {
        try { config.setEnabled(true); } catch (error) {
          ctx.ui.notify(`pi-perf: ${(error as Error).message}`, "error"); return;
        }
        samplingEnabled = true;
        sampler.start();
        startRuntime();
        ctx.ui.notify("pi-perf: monitoring enabled", "info");
        return;
      }
      if (command === "off") {
        try { config.setEnabled(false); } catch (error) {
          ctx.ui.notify(`pi-perf: ${(error as Error).message}`, "error"); return;
        }
        samplingEnabled = false;
        sampler.stop();
        releaseObservedFrame?.();
        startupFramePending = false;
        stopRuntime();
        ctx.ui.notify("pi-perf: monitoring disabled; timers and observers released", "info");
        return;
      }
      if (command === "reset") {
        spans.reset();
        marks.reset();
        memory.reset();
        timeline.clear();
        sampler.resetLoop();
        sharedRegistry.reset(providerOwner);
        telemetryRegistry.resetAll(providerOwner);
        eluStart = performance.eventLoopUtilization();
        ctx.ui.notify("pi-perf: UI latency and memory baselines reset", "info");
        return;
      }
      if (command === "log") {
        ctx.ui.notify(`pi-perf: ${LOG_PATH} (UI samples ≥ ${LOG_THRESHOLD_MS}ms; memory every ${MEMORY_LOG_MS / 1000}s)`, "info");
        return;
      }

      const needsTrends = !command || ["7d", "30d", "export", "open"].includes(command);
      const trendResult = needsTrends ? await history.trends(command === "7d" || !command ? 7 : 30).catch(error => {
        ctx.ui.notify(`pi-perf: cannot read trends (${(error as Error).message})`, "warning");
        return { rows: [], skippedFiles: 0, limited: false, combinedGroups: false, busyDays: 0 };
      }) : { rows: [], skippedFiles: 0, limited: false, combinedGroups: false, busyDays: 0 };
      const { rows: trends, skippedFiles, limited, combinedGroups, busyDays } = trendResult;
      if (command === "7d" || command === "30d") {
        ctx.ui.notify(trendText(trends, skippedFiles, limited, combinedGroups, busyDays), "info"); return;
      }
      recordHostGcMetrics();
      const mem = memory.summary();
      const hostReloadCache = readHostReloadCacheStatus();
      updateSharedRuntime(mem.current);
      const pluginTelemetry = telemetryRegistry.snapshot();
      if (command === "memory") {
        ctx.ui.notify(memoryReport(mem), "info");
        return;
      }

      if (command === "top") {
        const rows = pluginRows(pluginTelemetry.measures, 20);
        ctx.ui.notify([
          "Slowest plugin spans (p95)",
          latencyTable(rows, true),
          "",
          `Producers ${pluginTelemetry.owners.join(", ") || "none"}`,
        ].join("\n"), "info");
        return;
      }

      if (command === "export" || command === "open") {
        const loop = eventLoopSnapshot();
        const report: PerfReportData = {
          trends,
          maintenanceError: history.maintenanceError,
          skippedDailyFiles: skippedFiles,
          trendsLimited: limited,
          trendGroupsCombined: combinedGroups,
          busyTrendDays: busyDays,
          generatedAt: Date.now(),
          sessionId,
          monitoringEnabled: samplingEnabled,
          uiMetrics: spans.stats(),
          telemetry: pluginTelemetry,
          memory: mem,
          eventLoop: loop,
          instrumentation: {
            frame: uiStatus.doRender,
            request: uiStatus.requestRender,
            input: uiStatus.handleTerminalInput || inputUnsubscribe !== undefined,
            hostReloadCache: hostReloadCache.healthy,
            hostReloadCacheDetail: hostReloadCache.label,
            ...(uiStatus.detail ? { detail: uiStatus.detail } : {}),
          },
          timeline: timeline.snapshot(),
        };
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          const path = await writePerfReport(report);
          if (command === "open") await openPerfReport(path);
          ctx.ui.notify(command === "open" ? `pi-perf: opened ${path}` : `pi-perf: exported ${path}`, "info");
        } catch (error) {
          ctx.ui.notify(`pi-perf: report failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`, "warning");
        }
        return;
      }

      const loop = eventLoopSnapshot();
      const instrumentation = uiStatus.doRender
        ? `frame hook ok · request hook ${uiStatus.requestRender ? "ok" : "missing"} · input ${uiStatus.handleTerminalInput ? "raw hook" : "public fallback"}`
        : `frame hook missing · ${uiStatus.detail ?? "unknown"}`;
      const inventoryStatus = packageInventoryError ? "包名解析失败（local）" : identity.packageResolveMs === undefined ? "包名解析中" : `包名解析 ${identity.packageResolveMs.toFixed(2)}ms（进程内缓存）`;
      const trendBody = [inventoryStatus, "最近 7 天（/perf 30d 查看 30 天）", trendText(trends, skippedFiles, limited, combinedGroups, busyDays),
        `低频采样 ${samplingEnabled ? "on (60s)" : "off"} · 细粒度探针 ${enabled ? "on" : "off"}`];
      if (!enabled) {
        ctx.ui.notify([...trendBody, "细粒度表格与 TUI 探针：/perf on"].join("\n"), "info"); return;
      }
      const body = [
        ...trendBody,
        "",
        "UI latency (event/action → completed terminal frame)",
        latencyTable(spans.stats()),
        "",
        "Plugin spans (all producers, p95 order)",
        latencyTable(pluginRows(pluginTelemetry.measures, 40), true),
        "",
        "Plugin observations, gauges, and counters",
        pluginSignals(pluginTelemetry),
        "",
        samplingEnabled
          ? `Event loop（本分钟窗口，整分钟采样后重置；/perf reset 也会重置）  p50 ${formatMs(loop.p50Ms)}  p95 ${formatMs(loop.p95Ms)}  p99 ${formatMs(loop.p99Ms)}  max ${formatMs(loop.maxMs)}  utilization ${(loop.utilization * 100).toFixed(1)}%`
          : "Event loop  monitoring disabled",
        "",
        "Memory",
        memoryReport(mem),
        "",
        `Instrumentation  ${instrumentation}`,
        `Host  ${hostReloadCache.label}`,
        `Provider ${enabled ? "on" : "off"} · UI subscribers ${sharedRegistry.getStatus().subscribers} · telemetry producers ${telemetryRegistry.getStatus().producers}`,
        `Slow-log threshold ${formatMs(LOG_THRESHOLD_MS)} · /perf log`,
      ].join("\n");
      ctx.ui.notify(body, "info");
    },
  });
}
