import { isRetryableAssistantError, retryDelayMs, type AssistantMessage, type RetryPolicy } from "@earendil-works/pi-ai";
import type { Config } from "./config.ts";
import type { Attempt } from "./generate.ts";

export interface RetryInfo { attempt: number; kind: "invalid-output" | "network"; reason: string; delayMs: number }
export interface RequestRetryOptions { enabled: boolean; pi?: Partial<RetryPolicy> }
export function networkPolicy(config: Config, options: RequestRetryOptions): RetryPolicy {
  const pi = options.pi;
  return { enabled: options.enabled && (config.retry.network === "pi" ? pi?.enabled ?? true : config.retry.network > 0), maxRetries: config.retry.network === "pi" ? pi?.maxRetries ?? 3 : config.retry.network, baseDelayMs: pi?.baseDelayMs ?? 2000, maxAgentDelayMs: pi?.maxAgentDelayMs ?? 60000 };
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Counters are per frozen request, shared across its content and transport failures, never nested.
 * Native owns its own retry loop; shadows call this with enabled:false.
 */
export async function withRequestRetries<T>(config: Config, signal: AbortSignal, attempts: Attempt[], checkpoint: () => Promise<boolean>, options: RequestRetryOptions, run: (retry?: RetryInfo) => Promise<T>): Promise<T> {
  const policy = networkPolicy(config, options);
  let retries = 0, retry: RetryInfo | undefined;
  for (let attempt = 1;; attempt++) {
    signal.throwIfAborted();
    const before = attempts.length;
    try { const result = await run(retry); signal.throwIfAborted(); return result; }
    catch (error) {
      const current = attempts.length > before ? attempts.at(-1) : undefined;
      if (current) current.error = String(error);
      if (!current || !current.sent || !options.enabled || signal.aborted || /dynamic-deadline-exceeded|compaction-total-deadline-exceeded|attempt-log-unavailable|recovery-budget-unavailable|custom-restored-context-budget-overflow/.test(String(error))) throw error;
      // Match Pi's public compact() classifier for error responses and thrown transport failures.
      const transport = (current.stopReason === "error" || !current.usageKnown) && isRetryableAssistantError({ stopReason: "error", errorMessage: current.providerError ?? String(error) } as AssistantMessage);
      const content = /stream.*(interrupt|premature|end|closed)|unexpected.*(EOF|end)/i.test(String(error)) || current.stopReason === "stop" || current.stopReason === "toolUse" || current.stopReason === "length" || current.stopReason === "aborted";
      let kind: RetryInfo["kind"], delayMs: number;
      if (transport && policy.enabled && policy.maxRetries > 0 && retries < 1) { kind = "network"; delayMs = retryDelayMs(policy, 1); }
      else if (content && retries < 1) { kind = "invalid-output"; delayMs = 0; }
      else { await checkpoint(); throw error; }
      retries++;
      retry = { attempt: attempt + 1, kind, reason: String(error), delayMs };
      current.retryScheduled = retry;
      if (!await checkpoint()) throw new Error("attempt-log-unavailable");
      await wait(delayMs, signal);
    }
  }
}

export interface FailureRecord { failures: number; retryAfter: number }
/** Bounded session-local circuit breaker, restored from run logs; user cancellation is never a failure. */
export class FailureBackoff {
  private records = new Map<string, FailureRecord>();
  restore(key: string, record: FailureRecord): void { if (Number.isSafeInteger(record.failures) && record.failures > 0 && Number.isFinite(record.retryAfter)) this.records.set(key, { ...record }); }
  blocked(key: string, now = Date.now()): FailureRecord | undefined { const value = this.records.get(key); return value && value.failures >= 2 && value.retryAfter > now ? { ...value } : undefined; }
  settle(key: string, outcome: "success" | "failure" | "cancelled", now = Date.now()): FailureRecord | undefined {
    if (outcome === "success") { this.records.delete(key); return; }
    if (outcome === "cancelled") return;
    const failures = (this.records.get(key)?.failures ?? 0) + 1;
    const value = { failures, retryAfter: now + Math.min(60, 5 * 2 ** Math.min(4, failures - 1)) * 60000 };
    this.records.delete(key); this.records.set(key, value);
    if (this.records.size > 128) this.records.delete(this.records.keys().next().value!);
    return { ...value };
  }
}
