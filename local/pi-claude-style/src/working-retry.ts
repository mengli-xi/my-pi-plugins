import { Loader, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { RetryStart } from "./compat/working-retry.ts";

export type RetryCategory = "网络异常" | "限流" | "上游不可用" | "异常";
export function retryCategory(error: string): RetryCategory {
  if (/\b429\b|rate[ _-]?limit/i.test(error)) return "限流";
  if (/\b503\b|upstream_unavailable|overloaded/i.test(error)) return "上游不可用";
  if (/connection[ _-]?reset|econnreset|timeout|timed?\s*out|etimedout|fetch failed|连接重置|超时/i.test(error)) return "网络异常";
  return "异常";
}

/** Immutable session fact: enough to project a wait without retaining raw errors. */
export interface RetrySnapshot {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startedAt: number;
  category: RetryCategory;
}
export function createRetrySnapshot(event: RetryStart, startedAt: number): RetrySnapshot {
  return Object.freeze({ attempt: event.attempt, maxAttempts: event.maxAttempts,
    delayMs: event.delayMs, startedAt, category: retryCategory(event.errorMessage) });
}

/** Sampled once per second even when the working animation ticks faster. */
export class WorkingRetryState {
  private snapshot?: RetrySnapshot;
  private sampledSecond = -1;
  private text = "";
  start(event: RetryStart, now: number): void { this.restore(createRetrySnapshot(event, now)); }
  restore(snapshot: RetrySnapshot): void {
    this.snapshot = snapshot;
    this.sampledSecond = -1;
    this.text = "";
  }
  clear(): void { this.snapshot = undefined; this.text = ""; }
  active(): boolean { return this.snapshot !== undefined; }
  nextRefreshAt(now: number): number {
    if (!this.snapshot) return Infinity;
    const { startedAt, delayMs } = this.snapshot;
    const second = Math.max(0, Math.floor((now - startedAt) / 1000));
    return second >= Math.ceil(delayMs / 1000) ? Infinity : startedAt + (second + 1) * 1000;
  }
  format(now: number): string {
    if (!this.snapshot) return "";
    const { attempt, maxAttempts, delayMs, startedAt, category } = this.snapshot;
    const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    if (elapsedSeconds !== this.sampledSecond) {
      this.sampledSecond = elapsedSeconds;
      const seconds = Math.max(0, Math.ceil(delayMs / 1000) - elapsedSeconds);
      this.text = `${category} · 重试 ${attempt}/${maxAttempts} · ${seconds}s 后（Esc 取消）`;
    }
    return this.text;
  }
}

/** CC-owned public Loader, mounted in Pi's status slot by the compat adapter. */
export class RetryWorkingIndicator extends Loader {
  readonly kind = "working" as const;
  constructor(tui: TUI, message: string, frame: string) {
    super(tui, text => text, text => text, message, { frames: [frame] });
  }
  dispose(): void { this.stop(); }
  renderInBorder(width: number): string {
    return truncateToWidth((super.render(width + 2)[1] ?? "").trim(), width, "");
  }
  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }
}
