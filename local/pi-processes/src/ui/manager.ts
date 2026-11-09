import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  ProcessPanel,
  type ProcessPanelDetail,
  type ProcessPanelItem,
  type ProcessPanelOutputLine,
} from "pi-li-uikit/process-panel";

import type { ProcessSummary } from "../domain/types.js";
import type { ProcessHost, ProcessLogsResult } from "../host/process-host.js";

export type ManagerView = "list" | "logs";

export interface ProcessManagerOptions {
  readonly host: ProcessHost;
  readonly theme: Theme;
  readonly initialProcessId?: string;
  readonly directLogs?: boolean;
  readonly onClose: () => void;
  readonly onChanged?: () => void;
}

function isLive(process: ProcessSummary): boolean {
  return process.state === "starting" || process.state === "running" || process.state === "stopping";
}

function sortedRecords(host: ProcessHost): ProcessSummary[] {
  return [...host.records()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
}

/**
 * One semantic status for both views. A terminal cause exists only when neither
 * exit code nor signal explains the outcome; the outcome alone is then the
 * shorter wording, and UIKit falls back to it for the whole list when its status
 * column cannot spell the cause. Width lives in UIKit's column allocation, so
 * this adapter measures nothing and the detail always keeps the full status.
 */
function panelStatus(process: ProcessSummary): { status: string; short?: string } {
  if (process.terminal?.cause === "timeout") return { status: "timeout" };
  if (process.state === "succeeded") return { status: "success" };
  if (process.state === "failed" && process.terminal?.exitCode !== null && process.terminal?.exitCode !== undefined) {
    return { status: `exit ${process.terminal.exitCode}` };
  }
  if (process.terminal?.errorCode) {
    return { status: `${process.state} · ${process.terminal.errorCode}`, short: process.state };
  }
  return { status: process.state };
}

function panelItem(host: ProcessHost, process: ProcessSummary): ProcessPanelItem {
  const status = panelStatus(process);
  return {
    id: process.id,
    name: process.name,
    kind: process.kind,
    status: status.status,
    ...(status.short ? { statusShort: status.short } : {}),
    runtimeMs: process.runtimeMs,
    command: process.commandPreview,
    script: host.command(process.id) ?? process.commandPreview,
    live: isLive(process),
  };
}

/**
 * `host.disposed` turns true the moment disposal starts, so it cannot carry the
 * panel chrome on its own: cleanup may still be running, and a failed cleanup
 * leaves the Host quarantined with the next process call rejected. The Host
 * publishes the settled state; the panel only phrases it.
 */
function panelTitle(host: ProcessHost): string {
  switch (host.containment) {
    case "contained": return "Processes · runtime contained";
    case "failed": return "Processes · runtime cleanup incomplete";
    case "pending": return "Processes · containment in progress";
    default: return "Processes";
  }
}

function panelHint(host: ProcessHost): string {
  switch (host.containment) {
    case "contained":
      return "Runtime contained; the next process call starts a new runtime.";
    case "failed": {
      // Containment leaves an unresolved group live, so live records name the
      // groups that survived; several records can share one PGID.
      const unresolved = new Set(
        host.records().filter(isLive).map((process) => process.pgid ?? `record:${process.id}`),
      ).size;
      const groups = unresolved > 0
        ? `${unresolved} process group${unresolved === 1 ? "" : "s"} unresolved`
        : "Cleanup incomplete";
      return `${groups}; process calls rejected until cleanup resolves.`;
    }
    case "pending":
      return "Runtime containment in progress; these records are not final yet.";
    default:
      return "Select a process to inspect output; type to filter.";
  }
}

/** A log request needs a live Supervisor; the rest of the detail does not. */
function logsUnavailableNote(host: ProcessHost, error: unknown): string {
  switch (host.containment) {
    case "contained":
      return "Logs unavailable: runtime contained; the supervisor is gone.";
    case "failed":
      return "Logs unavailable: cleanup is incomplete; the supervisor is unreachable.";
    case "pending":
      return "Logs unavailable: runtime containment is still in progress.";
    default:
      return `Logs unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Readable logs keep the detail as it has always been: watch aggregates only.
 * The diagnostic facts below belong to the path where the log request failed,
 * where they are the only thing left that explains the record.
 */
function detailMetadata(host: ProcessHost, process: ProcessSummary, logsError: unknown, logsFailed: boolean): ProcessPanelOutputLine[] {
  const lines: ProcessPanelOutputLine[] = [];
  const terminal = process.terminal;
  if (logsFailed) {
    if (terminal?.errorCode || terminal?.messagePreview) {
      lines.push({
        text: `Cause: ${[terminal.errorCode, terminal.messagePreview].filter(Boolean).join(" · ")}`,
        tone: "warning",
      });
    }
    if (terminal && (terminal.exitCode !== null || terminal.signal !== null)) {
      lines.push({
        text: `Exit: ${terminal.exitCode ?? "none"}${terminal.signal ? ` · signal ${terminal.signal}` : ""}`,
        tone: "muted",
      });
    }
    lines.push({
      text: `Started ${process.startedAt}${process.endedAt ? ` · ended ${process.endedAt}` : ""}`,
      tone: "muted",
    });
    if (process.pid !== undefined || process.pgid !== undefined) {
      lines.push({ text: `PID ${process.pid ?? "unknown"} · PGID ${process.pgid ?? "unknown"}`, tone: "muted" });
    }
  }
  for (const watch of host.notificationSnapshot().watches.filter((entry) => entry.processId === process.id)) {
    lines.push({
      text: `Watch ${watch.key} · ${watch.matchedCount} matched${watch.suppressedCount > 0 ? ` · ${watch.suppressedCount} suppressed` : ""}`,
      tone: "muted",
    });
  }
  if (logsFailed) lines.push({ text: logsUnavailableNote(host, logsError), tone: "warning" });
  return lines;
}

/** Thin domain adapter over pi-li-uikit's shared ProcessPanel. */
export class ProcessManagerEditor implements Component, Focusable {
  readonly tui: TUI;
  readonly wantsMouse = true;
  readonly #panel: ProcessPanel<string>;

  constructor(tui: TUI, _theme: Theme, _keybindings: KeybindingsManager, options: ProcessManagerOptions) {
    this.tui = tui;
    // A contained runtime keeps its final records readable, and only an explicit
    // process tool call creates the next generation; it never re-runs the
    // contained command. Title and hint are callbacks so the panel keeps telling
    // the truth while containment settles under an open panel.
    this.#panel = new ProcessPanel({
      tui,
      theme: options.theme,
      title: () => panelTitle(options.host),
      listHint: () => panelHint(options.host),
      getItems: () => sortedRecords(options.host).map((process) => panelItem(options.host, process)),
      loadDetail: async (id): Promise<ProcessPanelDetail> => {
        // Everything except output comes from local records, so a Supervisor that
        // can no longer serve logs must not blank the whole detail.
        let logs: ProcessLogsResult | undefined;
        let logsError: unknown;
        try {
          logs = await options.host.logs({
            action: "logs",
            target: id,
            stream: "both",
            tailLines: 2_000,
            mode: "literal",
          });
        } catch (error) {
          logsError = error;
        }
        const process = options.host.summary(id) ?? logs?.process;
        if (!process) throw logsError ?? new Error(`[process/not-found] process '${id}' is unknown`);
        const retained = Math.max(0, process.logs.nextSequence - process.logs.earliestSequence);
        const metadata = detailMetadata(options.host, process, logsError, logs === undefined);
        return {
          item: panelItem(options.host, process),
          ...(metadata.length > 0 ? { metadata } : {}),
          output: logs ? logs.lines.map((line) => ({ text: line.text })) : [],
          totalLines: retained + (logs?.droppedLines ?? process.logs.droppedLines),
        };
      },
      onStop: async (id) => {
        await options.host.stop({ action: "stop", target: id });
        options.onChanged?.();
      },
      onClose: options.onClose,
      ...(options.initialProcessId ? { initialProcessId: options.initialProcessId } : {}),
      ...(options.directLogs ? { directDetail: true } : {}),
      maxVisible: 12,
    });
  }

  get focused(): boolean { return this.#panel.focused; }
  set focused(value: boolean) { this.#panel.focused = value; }
  get view(): ManagerView { return this.#panel.view === "detail" ? "logs" : "list"; }
  get selectedId(): string | undefined { return this.#panel.selectedId; }
  get confirmation(): string | undefined { return this.#panel.confirmationState; }

  setAvailableHeight(rows: number): void { this.#panel.setAvailableHeight(rows); }
  setScreenOrigin(row: number, column: number): void { this.#panel.setScreenOrigin(row, column); }
  render(width: number): string[] { return this.#panel.render(width); }
  handleInput(data: string): void { this.#panel.handleInput(data); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.#panel.handleMouse(event); }
  invalidate(): void { this.#panel.invalidate(); }
  dispose(): void { this.#panel.dispose(); }
  refresh(): void { this.#panel.refresh(); }
}
