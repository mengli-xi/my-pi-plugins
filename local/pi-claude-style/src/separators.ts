import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { truncateWithMutedEllipsis } from "./ellipsis.ts";
import {
  formatRunDividerText,
  formatTurnDividerText,
} from "./separator-format.ts";
import type {
  RunMetricsSnapshot,
  SeparatorsConfig,
  WorkingConfig,
} from "./types.ts";

import { TranscriptSeparators, TURN_SEPARATOR_TYPE, RUN_SEPARATOR_TYPE, type TurnSeparatorData, type RunSeparatorData } from "./separator-state.ts";
export { TranscriptSeparators } from "./separator-state.ts";

class DividerComponent implements Component {
  // Declared and assigned separately: Node's strip-only TypeScript, which runs
  // the tests here, rejects constructor parameter properties.
  private readonly text: string;
  private readonly theme: Theme;
  private readonly kind: "turn" | "run";
  private readonly status?: RunMetricsSnapshot["status"];

  constructor(
    text: string,
    theme: Theme,
    kind: "turn" | "run",
    status?: RunMetricsSnapshot["status"],
  ) {
    this.text = text;
    this.theme = theme;
    this.kind = kind;
    this.status = status;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (!this.text) {
      return [this.theme.fg("borderMuted", "─".repeat(safeWidth))];
    }
    const label = this.colorLabel(
      truncateWithMutedEllipsis(
        this.text,
        Math.max(1, safeWidth - 4),
        this.theme,
      ),
    );
    const labelWidth = visibleWidth(label);
    const availableRule = Math.max(0, safeWidth - labelWidth - 2);
    const leftWidth =
      this.kind === "turn"
        ? Math.max(1, Math.floor(availableRule / 3))
        : Math.min(1, availableRule);
    const rightWidth = Math.max(0, availableRule - leftWidth);
    return [
      `${this.theme.fg("borderMuted", "─".repeat(leftWidth))} ${label} ${this.theme.fg(
        "borderMuted",
        "─".repeat(rightWidth),
      )}`,
    ];
  }

  invalidate(): void {}

  private colorLabel(text: string): string {
    if (this.kind === "turn") return this.theme.fg("dim", text);
    const glyph = text.slice(0, 1);
    const rest = text.slice(1);
    const color =
      this.status === "failed"
        ? "error"
        : this.status === "cancelled"
          ? "warning"
          : "success";
    return `${this.theme.fg(color, glyph)}${this.theme.fg("muted", rest)}`;
  }
}

export function registerTranscriptSeparators(
  pi: ExtensionAPI,
  config: SeparatorsConfig,
  working: WorkingConfig,
): TranscriptSeparators {
  registerTranscriptSeparatorRenderers(pi, config, working);
  return new TranscriptSeparators(pi, config);
}

export function registerTranscriptSeparatorRenderers(pi: ExtensionAPI, config: SeparatorsConfig, working: WorkingConfig): void {
  pi.registerEntryRenderer<TurnSeparatorData>(
    TURN_SEPARATOR_TYPE,
    (entry, _options, theme) => {
      if (!config.enabled || !config.showTurnSeparators) return undefined;
      const nextTurn = entry.data?.nextTurn ?? 1;
      return new DividerComponent(
        formatTurnDividerText(nextTurn, config.showTurnNumber),
        theme,
        "turn",
      );
    },
  );
  pi.registerEntryRenderer<RunSeparatorData>(
    RUN_SEPARATOR_TYPE,
    (entry, _options, theme) => {
      const snapshot = entry.data?.snapshot;
      if (!snapshot) return undefined;
      return new DividerComponent(
        formatRunDividerText(snapshot, working),
        theme,
        "run",
        snapshot.status,
      );
    },
  );
}
