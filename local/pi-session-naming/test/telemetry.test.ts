import assert from "node:assert/strict";
import test from "node:test";
import { SessionNamingTelemetry } from "../src/telemetry.ts";

const KEY = Symbol.for("pi.perf.telemetry.v1");

test("telemetry discovers pi-perf lazily and releases its reporter", () => {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const previous = scope[KEY];
  const samples: Array<{ kind: string; name: string; value: number }> = [];
  let releases = 0;
  try {
    delete scope[KEY];
    const telemetry = new SessionNamingTelemetry();
    telemetry.increment("before-provider");
    scope[KEY] = {
      version: 1,
      acquireReporter(owner: string) {
        assert.equal(owner, "pi-session-naming");
        return {
          reporter: {
            configure() {},
            measure(name: string, value: number) {
              samples.push({ kind: "measure", name, value });
            },
            increment(name: string, value = 1) {
              samples.push({ kind: "counter", name, value });
            },
          },
          release() {
            releases++;
          },
        };
      },
    };
    telemetry.measure("generation.total", 12.5, { outcome: "success" });
    telemetry.increment("generation.success");
    telemetry.release();
    assert.deepEqual(samples, [
      { kind: "measure", name: "generation.total", value: 12.5 },
      { kind: "counter", name: "generation.success", value: 1 },
    ]);
    assert.equal(releases, 1);
  } finally {
    if (previous === undefined) delete scope[KEY];
    else scope[KEY] = previous;
  }
});
