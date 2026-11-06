/** One attempt owns its deadline and every continuation across asynchronous init. */
export class ViewInitialization {
  readonly abort = new AbortController();
  finished = false;
  expired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(timeoutMs: number, expired: () => void) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.abort.signal.aborted && !this.finished) { this.expired = true; expired(); }
    }, timeoutMs);
    this.timer.unref?.();
  }
  assertActive() { this.abort.signal.throwIfAborted(); }
  async wait<T>(pending: PromiseLike<T> | T): Promise<T> {
    // The operation may synchronously request close before returning its
    // promise. Abandon its continuation, but still consume a late rejection.
    if (this.abort.signal.aborted) void Promise.resolve(pending).catch(() => undefined);
    this.assertActive();
    return new Promise<T>((resolve, reject) => {
      const signal = this.abort.signal;
      const cancelled = () => reject(signal.reason);
      signal.addEventListener("abort", cancelled, { once: true });
      Promise.resolve(pending).then(value => {
        signal.removeEventListener("abort", cancelled);
        if (signal.aborted) reject(signal.reason); else resolve(value);
      }, error => { signal.removeEventListener("abort", cancelled); reject(error); });
    });
  }
  complete() { this.assertActive(); this.finished = true; this.clearTimer(); }
  cancel() { this.clearTimer(); this.abort.abort(new Error("Managed view initialization abandoned")); }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
