import assert from "node:assert/strict";
import test from "node:test";
import {
  codexHistoryWindow,
  computeBurn,
  formatCapacityReport,
  formatDuration,
  parseJsonl,
  percentPerMTok,
  type UsageSample,
} from "../stats.ts";
import type { ModelCapacitySnapshotV2 } from "../src/contracts.ts";

function sample(overrides: Partial<UsageSample>): UsageSample {
  return {
    ts: 0,
    usedPercent: 0,
    resetAt: null,
    windowSeconds: 604_800,
    planType: "pro",
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    maxContextTokens: 0,
    requests: 0,
    ...overrides,
  };
}

test("burn attribution preserves legacy JSONL semantics", () => {
  const now = 1_000_000;
  const burn = computeBurn([
    sample({ ts: now - 300, usedPercent: 10 }),
    sample({ ts: now - 200, usedPercent: 12, inputTokens: 500_000, maxContextTokens: 100_000, requests: 5 }),
    sample({ ts: now - 100, usedPercent: 15, inputTokens: 500_000, maxContextTokens: 340_000, requests: 2 }),
  ], now);
  assert.equal(burn.small.deltaPercent, 2);
  assert.equal(burn.large.deltaPercent, 3);
  assert.equal(burn.last24hPercent, 5);
  assert.equal(percentPerMTok(burn.small), 4);
  assert.equal(percentPerMTok(burn.large), 6);
});

test("resets and changes between 5h and 7d windows are not burn deltas", () => {
  const now = 1_000_000;
  const burn = computeBurn([
    sample({ ts: now - 300, usedPercent: 90, windowSeconds: 604_800 }),
    sample({ ts: now - 200, usedPercent: 2, windowSeconds: 604_800, inputTokens: 100_000 }),
    sample({ ts: now - 100, usedPercent: 3, windowSeconds: 18_000, inputTokens: 100_000 }),
  ], now);
  assert.equal(burn.last24hPercent, 0);
  assert.equal(burn.small.deltaPercent, 0);
});

test("JSONL parsing survives torn lines", () => {
  const text = `${JSON.stringify(sample({ ts: 1, usedPercent: 2 }))}\n{torn\n${JSON.stringify(sample({ ts: 2, usedPercent: 3 }))}\n`;
  assert.deepEqual(parseJsonl(text).map((entry) => entry.usedPercent), [2, 3]);
});

test("history prefers the account seven-day window over five-hour", () => {
  const provider = {
    provider: "openai-codex" as const,
    state: "ready" as const,
    windows: [
      { kind: "five_hour" as const, usedPercent: 10, remainingPercent: 90, windowSeconds: 18_000 },
      { kind: "seven_day" as const, usedPercent: 20, remainingPercent: 80, windowSeconds: 604_800 },
      { kind: "five_hour" as const, usedPercent: 30, remainingPercent: 70, label: "Spark" },
    ],
  };
  assert.equal(codexHistoryWindow(provider)?.usedPercent, 20);
});

test("multi-provider report distinguishes load, gateway, and subscription windows", () => {
  const now = 1_000;
  const snapshot: ModelCapacitySnapshotV2 = {
    version: 2,
    ownerId: "fixture-owner",
    revision: 3,
    providers: [
      {
        provider: "fixture-gateway",
        state: "ready",
        gateway: { active: 4, queued: 1, backgroundActive: 0, maxActive: 20 },
        models: { sol: { loadPercent: 50 } },
      },
      {
        provider: "openai-codex",
        state: "ready",
        plan: "pro",
        windows: [{ kind: "seven_day", usedPercent: 79, remainingPercent: 21, resetsAt: now + 3_600 }],
      },
      {
        provider: "xai",
        state: "stale",
        windows: [{ kind: "weekly", usedPercent: 0, remainingPercent: 100 }],
      },
      {
        provider: "deepseek",
        state: "ready",
        balances: [{ currency: "CNY", remaining: 9.21, granted: 0, toppedUp: 9.21 }],
      },
    ],
  };
  const report = formatCapacityReport(snapshot, computeBurn([], now), now);
  assert.match(report, /fixture-gateway: gateway 4\/20 · queue 1 · 1 model loads/);
  assert.match(report, /openai-codex: pro · 7d 21% left/);
  assert.match(report, /xai \(stale\): weekly 100% left/);
  assert.match(report, /deepseek: ¥9\.21 \(top-up 9\.21, grant 0\.00\)/);
});

test("durations format for humans", () => {
  assert.equal(formatDuration(0), "now");
  assert.equal(formatDuration(90), "1m");
  assert.equal(formatDuration(3 * 3_600 + 120), "3h 2m");
  assert.equal(formatDuration(6 * 86_400 + 17 * 3_600), "6d 17h");
});
