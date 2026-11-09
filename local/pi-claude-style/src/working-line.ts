import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  paintClaudeShimmer,
  paintWorkingStatusValue,
  segment,
  type CyberSegment,
  type WorkingStatusTone,
} from "./cyber-style.ts";
import {
  truncateWithMutedEllipsis,
} from "./ellipsis.ts";
import { formatDuration, formatTokenCount, formatTps } from "./format.ts";
import type { RunMetricsSnapshot, WorkingConfig } from "./types.ts";
import { TURN_ICON, workingLabel } from "./working-label.ts";
import { LOADER_WORKING_CONTINUATION_INDENT } from "./working-layout.ts";

/**
 * Every metric reads as `glyph value` / `value unit` with single spaces and no
 * internal padding, so the row stays tight.
 *
 * No segment reserves historical headline width. The spinner always uses one
 * headline row plus one status row; each row gets its own width budget.
 */
const CANCEL_HINT = "esc to cancel";
const UNKNOWN_METRIC = "–";

export interface StickyTokens {
  input: number | undefined;
  output: number | undefined;
  outputEstimated: boolean;
}

export function cyberTokenSegment(
  tokens: StickyTokens,
  config: WorkingConfig,
  theme: Theme,
  fixedWidth: boolean,
): string {
  // Usage only arrives with the first partial response. The counters claim
  // their cells immediately so nothing reflows, but read as unknown rather
  // than as a confirmed zero until a provider reports.
  const value = (
    glyph: "↑" | "↓",
    count: number | undefined,
    tone: "input" | "output",
  ) => {
    const text = `${glyph} ${count === undefined ? UNKNOWN_METRIC : formatTokenCount(count)}`;
    return count === undefined
      ? theme.fg("dim", text)
      : paintStatusValue(text, tone);
  };
  const parts: string[] = [];
  if (config.showInputTokens && (fixedWidth || tokens.input !== undefined)) {
    parts.push(value("↑", tokens.input, "input"));
  }
  if (config.showOutputTokens && (fixedWidth || tokens.output !== undefined)) {
    parts.push(value("↓", tokens.output, "output"));
  }
  return parts.join(" ");
}

export function paintStatusValue(
  text: string,
  tone: WorkingStatusTone = "elapsed",
): string {
  return paintWorkingStatusValue(text, tone);
}

/** The rate reads as one word: no space between the count and its unit. */
export function cyberTps(
  tps: number,
  estimated: boolean,
  theme: Theme,
  _fixedWidth?: boolean,
): string {
  const marker = estimated ? theme.fg("dim", "~") : "";
  const tone = tps < 20 ? "tpsSlow" : tps < 50 ? "tpsSteady" : "tpsFast";
  return `${marker}${paintStatusValue(formatTps(tps), tone)}`;
}

/**
 * Metrics arrive at different points in a run. Cumulative values stay sticky
 * once observed, but rendered widths do not: a long headline or rate must not
 * leave an invisible high-water column behind after the text gets shorter.
 */
export class WorkingLineSlots {
  private input: number | undefined;
  private output: number | undefined;
  private outputEstimated = false;
  private tps: number | undefined;
  private tpsEstimated = false;
  private ttftMs: number | undefined;
  private thinkingMs: number | undefined;

  reset(): void {
    this.input = undefined;
    this.output = undefined;
    this.outputEstimated = false;
    this.tps = undefined;
    this.tpsEstimated = false;
    this.ttftMs = undefined;
    this.thinkingMs = undefined;
  }

  update(snapshot: RunMetricsSnapshot): void {
    if (snapshot.inputTokens !== undefined) {
      this.input = Math.max(this.input ?? 0, snapshot.inputTokens);
    }
    if (snapshot.outputTokens !== undefined) {
      this.output = Math.max(this.output ?? 0, snapshot.outputTokens);
    }
    this.outputEstimated = snapshot.outputEstimated;
    this.tps = snapshot.tps !== undefined && snapshot.tps > 0
      ? snapshot.tps
      : undefined;
    this.tpsEstimated = this.tps !== undefined && snapshot.tpsEstimated;
    if (snapshot.ttftMs !== undefined) this.ttftMs = snapshot.ttftMs;
    if (snapshot.thinkingMs !== undefined) this.thinkingMs = snapshot.thinkingMs;
  }

  tokens(): StickyTokens {
    return {
      input: this.input,
      output: this.output,
      outputEstimated: this.outputEstimated,
    };
  }

  tpsText(theme: Theme): string {
    return this.tps === undefined
      ? ""
      : cyberTps(this.tps, this.tpsEstimated, theme, true);
  }

  ttft(): number | undefined {
    return this.ttftMs;
  }

  thinking(): number | undefined {
    return this.thinkingMs;
  }
}

/** Width of a joined segment list, including reserved metric widths. */
function segmentsWidth(
  items: readonly CyberSegment[],
  separatorWidth: number,
): number {
  return items.reduce(
    (width, item, index) =>
      width + item.budgetWidth + (index > 0 ? separatorWidth : 0),
    0,
  );
}

/**
 * Keep headline and status on two physical rows regardless of available room.
 * Elapsed time is required; optional metrics drop by importance on the status
 * row, while the headline is truncated independently on the first row.
 */
export function fitTwoLineWorkingMessage(
  label: string,
  statusPrefix: string,
  elapsed: string,
  optional: readonly CyberSegment[],
  maxWidth: number,
  separator: string,
  theme: Theme,
): string {
  const budget = Math.max(1, Math.floor(maxWidth));
  const separatorWidth = visibleWidth(separator);
  const fittedLabel = truncateWithMutedEllipsis(label, budget, theme);
  const fittedElapsed = truncateWithMutedEllipsis(elapsed, budget, theme);
  const prefixBudget = Math.max(
    0,
    budget - visibleWidth(fittedElapsed) - separatorWidth,
  );
  const prefix = statusPrefix
    ? truncateWithMutedEllipsis(statusPrefix, prefixBudget, theme)
    : "";
  const required = [
    ...(prefix ? [segment(prefix, 100)] : []),
    segment(fittedElapsed, 100),
  ];
  const survivors = [...optional];
  const byImportance = [...optional].sort(
    (left, right) => left.importance - right.importance,
  );
  for (const candidate of byImportance) {
    if (segmentsWidth([...required, ...survivors], separatorWidth) <= budget) {
      break;
    }
    const index = survivors.indexOf(candidate);
    if (index >= 0) survivors.splice(index, 1);
  }
  const status = [...required, ...survivors]
    .map((item) => item.text)
    .join(separator);

  return `${fittedLabel}\n${LOADER_WORKING_CONTINUATION_INDENT}${status}`;
}

export function buildCyberWorkingLine(
  verb: string,
  snapshot: RunMetricsSnapshot,
  slots: WorkingLineSlots,
  config: WorkingConfig,
  theme: Theme,
  providerStatus = "",
  maxWidth = config.messageWidth,
  now = Date.now(),
): string {
  // Values stay normal-weight and low-chroma, but categories have independent
  // dark tones. TPS alone is graded by rate.
  const duration = (milliseconds: number, tone: WorkingStatusTone) =>
    paintStatusValue(formatDuration(milliseconds), tone);
  const metric = (text: string, importance: number) => segment(text, importance);
  const separator = theme.fg("muted", " · ");

  const elapsed = duration(snapshot.elapsedMs, "elapsed");
  const items: CyberSegment[] = [];
  const tokens = cyberTokenSegment(slots.tokens(), config, theme, true);
  if (tokens) items.push(metric(tokens, 90));
  if (config.showTps) {
    const tps = slots.tpsText(theme);
    if (tps) items.push(metric(tps, 70));
  }
  const ttftMs = slots.ttft();
  if (config.showTtft && ttftMs !== undefined) {
    items.push(
      metric(`${theme.fg("muted", "first ")}${duration(ttftMs, "ttft")}`, 45),
    );
  }
  const thinkingMs = slots.thinking();
  if (config.showThinkingTime && thinkingMs !== undefined) {
    items.push(
      metric(
        `${theme.fg("muted", "thought ")}${duration(thinkingMs, "thinking")}`,
        40,
      ),
    );
  }
  if (config.showTurns && snapshot.turnCount > 0) {
    items.push(
      metric(
        `${theme.fg("muted", TURN_ICON)} ${paintStatusValue(
          String(snapshot.turnCount),
          "turns",
        )}`,
        50,
      ),
    );
  }
  if (snapshot.elapsedMs >= config.showCancelHintAfterMs) {
    items.push(segment(theme.fg("dim", CANCEL_HINT), 20));
  }

  return fitTwoLineWorkingMessage(
    paintClaudeShimmer(workingLabel(verb), now),
    providerStatus,
    elapsed,
    items,
    maxWidth,
    separator,
    theme,
  );
}
