import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunMetricsSnapshot, SeparatorsConfig } from "./types.ts";

export const TURN_SEPARATOR_TYPE = "pi-claude-transcript:turn-separator";
export const RUN_SEPARATOR_TYPE = "pi-claude-transcript:run-separator";

export interface TurnSeparatorData {
  nextTurn: number;
}

export interface RunSeparatorData {
  snapshot: RunMetricsSnapshot;
}

export class TranscriptSeparators {
  private pendingTurn = false;
  private pendingRun: RunMetricsSnapshot | undefined;

  private readonly pi: ExtensionAPI;
  private readonly config: SeparatorsConfig;

  constructor(pi: ExtensionAPI, config: SeparatorsConfig) {
    this.pi = pi;
    this.config = config;
  }

  startRun(): void {
    this.pendingTurn = false;
    this.pendingRun = undefined;
  }

  finishTurn(): void {
    if (!this.config.enabled || !this.config.showTurnSeparators) return;
    this.pendingTurn = true;
  }

  startTurn(turnIndex: number): boolean {
    if (
      !this.config.enabled ||
      !this.config.showTurnSeparators ||
      !this.pendingTurn ||
      turnIndex <= 0
    ) {
      return false;
    }
    this.pendingTurn = false;
    this.pi.appendEntry<TurnSeparatorData>(TURN_SEPARATOR_TYPE, {
      nextTurn: turnIndex + 1,
    });
    return true;
  }

  finishRun(snapshot: RunMetricsSnapshot): void {
    this.pendingTurn = false;
    if (!this.config.enabled || !this.config.showRunSeparator) return;
    this.pendingRun = snapshot;
  }

  settleRun(): void {
    if (!this.pendingRun) return;
    this.pi.appendEntry<RunSeparatorData>(RUN_SEPARATOR_TYPE, {
      snapshot: this.pendingRun,
    });
    this.pendingRun = undefined;
  }

  reset(): void {
    this.pendingTurn = false;
    this.pendingRun = undefined;
  }

  replacesDoneWidget(): boolean {
    return (
      this.config.enabled &&
      this.config.showRunSeparator &&
      this.config.replaceDoneWidget
    );
  }
}
