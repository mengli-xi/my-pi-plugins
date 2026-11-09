import { presentationPrototype } from "./presentation-owner.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Keep Pi's native /session report in a panel, without duplicating its math. */

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  captureSessionCommand,
  sessionInfoPrototype,
} from "./compat/session-info.ts";
import { declareProbes, markBroken, markOk, type Probe } from "./internals.ts";

const PATCH_STATE = Symbol.for("pi-claude-transcript.session-info.patch");
const PATCH_OWNER = Symbol("pi-claude-transcript.session-info.owner");

/** @see ./internals.ts — the names this patch cannot do without. */
export const PROBES: Probe[] = [
  {
    id: "session-info.handleSessionCommand",
    needs: "InteractiveMode.prototype.handleSessionCommand",
    breaks: "/session 回到 pi 的 20 行内联输出",
    check: () =>
      typeof sessionInfoPrototype<PatchablePrototype>()
        .handleSessionCommand === "function",
  },
  {
    id: "session-info.capture",
    needs: "InteractiveMode 实例的 chatContainer；报告组件通过公开 render(width) 物化",
    breaks: "同上：拿不到原处理器算出的报告，只能放它照常打印",
  },
];

type HandleFn = (this: unknown) => void;

interface PatchablePrototype {
  handleSessionCommand?: HandleFn;
  [key: symbol]: unknown;
}

interface PatchState {
  owner: symbol;
  original: HandleFn;
  patched: HandleFn;
}

export interface SessionInfoReport {
  title: string;
  /** Carries ANSI because Pi's native handler has already themed the report. */
  body: string;
  renderBody(width: number): string[];
}

export type SessionInfoPresenter = (
  report: SessionInfoReport,
) => boolean | Promise<boolean>;

export function installSessionInfoPopup(present: SessionInfoPresenter, pi?: ExtensionAPI): () => void {
  declareProbes(PROBES);
  const prototype = presentationPrototype(pi, sessionInfoPrototype<PatchablePrototype>(), "mode");
  const previous = prototype[PATCH_STATE] as PatchState | undefined;
  const original = previous?.owner === PATCH_OWNER
    ? previous.original
    : prototype.handleSessionCommand;
  if (typeof original !== "function") {
    markBroken(
      "session-info.handleSessionCommand",
      "handleSessionCommand 不是函数，patch 未安装",
    );
    return () => {};
  }

  const patched: HandleFn = function sessionInfoPopup(): void {
    const capture = captureSessionCommand(this, () => original.call(this));
    if (!capture.available) {
      markBroken("session-info.capture", "实例上没有 chatContainer");
      original.call(this);
      return;
    }

    const components = capture.children.filter((child): child is import("@earendil-works/pi-tui").Component =>
      typeof (child as { render?: unknown } | null)?.render === "function");
    const renderBody = (width: number): string[] => {
      const lines = components.flatMap((child) => child.render(width));
      const first = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
      if (first < 0 || stripTerminalSequences(lines[first]!).trim().toLowerCase() !== "session info") return lines;
      let start = first + 1;
      while (start < lines.length && !stripTerminalSequences(lines[start]!).trim()) start++;
      return lines.slice(start);
    };
    let report = "";
    try { report = renderBody(120).map((line) => line.trimEnd()).join("\n").trim(); }
    catch (error) { capture.error = error instanceof Error ? error.message : String(error); }
    if (capture.error || !report) {
      markBroken(
        "session-info.capture",
        capture.error ?? "原处理器写入的组件里没有可读文本",
      );
      // Run it again for real. Cheap — the handler is a fold over entries —
      // and the user ends up exactly where they would have been without this
      // extension.
      original.call(this);
      return;
    }
    markOk("session-info.capture");
    markOk("session-info.handleSessionCommand");

    const showNative = (): void => {
      original.call(this);
    };
    try {
      const presented = present({ title: "Session info", body: report, renderBody });
      if (typeof presented === "boolean") {
        if (presented) return;
        showNative();
        return;
      }
      void presented.then((accepted) => {
        if (!accepted) showNative();
      }).catch(() => {
        // An asynchronous presenter cannot throw back through the command
        // handler. Best-effort native output preserves the useful fallback.
        try { showNative(); } catch { /* the original session also retired */ }
      });
      return;
    } catch {
      // A stale UI context or unavailable presenter must not eat Pi's report.
    }
    showNative();
  };

  prototype.handleSessionCommand = patched;
  prototype[PATCH_STATE] = { owner: PATCH_OWNER, original, patched } satisfies PatchState;

  return () => {
    const state = prototype[PATCH_STATE] as PatchState | undefined;
    if (state?.owner !== PATCH_OWNER) return;
    if (prototype.handleSessionCommand === state.patched) {
      prototype.handleSessionCommand = state.original;
    }
    delete prototype[PATCH_STATE];
  };
}
