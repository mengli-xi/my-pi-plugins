const PERF_TELEMETRY_KEY = Symbol.for("pi.perf.telemetry.v1");
const OWNER = "pi-session-naming";

type Attributes = Record<string, string | number | boolean | undefined>;

interface Reporter {
  configure(config: { sampleWindow: number; slowSampleMs: number; logEnabled: boolean }): void;
  measure(name: string, ms: number, attributes?: Attributes): void;
  increment(name: string, delta?: number): void;
}

interface Registry {
  version: 1;
  acquireReporter(owner: string): { reporter: Reporter; release(): void };
}

function registry(): Registry | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[PERF_TELEMETRY_KEY];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<Registry>;
  return candidate.version === 1 && typeof candidate.acquireReporter === "function"
    ? candidate as Registry
    : undefined;
}

/** Optional producer for pi-perf. Discovery is retried because pi-perf may load later. */
export class SessionNamingTelemetry {
  private reporter: Reporter | undefined;
  private releaseReporter: (() => void) | undefined;

  measure(name: string, ms: number, attributes?: Attributes): void {
    if (!Number.isFinite(ms)) return;
    this.connect()?.measure(name, ms, attributes);
  }

  increment(name: string, delta = 1): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.connect()?.increment(name, delta);
  }

  release(): void {
    this.releaseReporter?.();
    this.releaseReporter = undefined;
    this.reporter = undefined;
  }

  private connect(): Reporter | undefined {
    if (this.reporter) return this.reporter;
    const current = registry();
    if (!current) return undefined;
    const handle = current.acquireReporter(OWNER);
    this.reporter = handle.reporter;
    this.releaseReporter = handle.release;
    this.reporter.configure({ sampleWindow: 256, slowSampleMs: 100, logEnabled: false });
    return this.reporter;
  }
}
