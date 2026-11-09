import assert from "node:assert/strict";
import test from "node:test";

import {
  readModelCapacitySnapshot,
  readModelCapacityRefreshReceipt,
  formatProviderCapacity,
  formatCapacityDetails,
  formatModelCapacity,
  formatModelCapacityColored,
  formatProviderCapacityColored,
  formatStatuslineCapacity,
  formatStatuslineCapacityColored,
  type ProviderCapacitySnapshot,
} from "../src/model-capacity.ts";

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

test("provider quota statusline pairs remaining percent with reset countdown", () => {
  const snapshot: ProviderCapacitySnapshot = {
    provider: "openai-codex",
    state: "ready",
    observedAt: NOW,
    windows: [
      { kind: "seven_day", usedPercent: 66, remainingPercent: 34, resetsAt: (NOW + (6 * 24 + 2) * 3_600_000) / 1_000 },
      { kind: "five_hour", usedPercent: 99, remainingPercent: 1, resetsAt: (NOW + 2 * 3_600_000 + 15 * 60_000) / 1_000 },
    ],
  };
  assert.equal(formatStatuslineCapacity(snapshot, "gpt-5.6", NOW), "1% · 2h15m 34% · 6d2h");
  assert.equal(
    formatStatuslineCapacityColored(theme, snapshot, "gpt-5.6", NOW),
    "<error>1%</error><dim> · 2h15m</dim> <success>34%</success><dim> · 6d2h</dim>",
  );
  assert.match(formatProviderCapacityColored(theme, snapshot, NOW), /<error>5h 1% left<\/error>/);
});

test("provider capacity details include exact UTC reset and remaining duration", () => {
  const snapshot: ProviderCapacitySnapshot = {
    provider: "openai-codex",
    state: "ready",
    observedAt: NOW,
    plan: "pro",
    windows: [
      { kind: "five_hour", usedPercent: 99, remainingPercent: 1, resetsAt: (NOW + 2 * 3_600_000 + 15 * 60_000) / 1_000 },
    ],
  };
  assert.deepEqual(formatCapacityDetails(snapshot, "gpt-5.6", NOW), {
    title: "openai-codex capacity",
    body: [
      "Provider: openai-codex",
      "Plan: pro",
      "State: Current",
      "Observed at: 2026-08-17 12:00:00.000 UTC",
      "",
      "5h quota",
      "Remaining: 1%",
      "Used: 99%",
      "Resets at: 2026-08-17 14:15:00.000 UTC",
      "Time remaining: 2h 15m",
    ].join("\n"),
  });
});

test("Fixture Quota shared quota is provider-level while differentiated quotas remain model-level", () => {
  const shared: ProviderCapacitySnapshot = {
    provider: "fixture-quota",
    state: "ready",
    observedAt: NOW,
    windows: [{ kind: "other", label: "Shared", usedPercent: 91, remainingPercent: 9, resetsAt: (NOW + 3_600_000) / 1_000 }],
  };
  assert.equal(formatModelCapacity(shared, "gpt-5.5"), undefined);
  assert.equal(formatStatuslineCapacity(shared, "gpt-5.5", NOW), "9% · 1h");
  assert.equal(formatStatuslineCapacityColored(theme, shared, "gpt-5.5", NOW), "<error>9%</error><dim> · 1h</dim>");
  assert.match(formatProviderCapacityColored(theme, shared, NOW), /<error>Shared 9% left<\/error>/);
  assert.deepEqual(formatCapacityDetails(shared, "gpt-5.5", NOW), {
    title: "fixture-quota capacity",
    body: [
      "Provider: fixture-quota",
      "State: Current",
      "Observed at: 2026-08-17 12:00:00.000 UTC",
      "",
      "Shared quota",
      "Remaining: 9%",
      "Used: 91%",
      "Resets at: 2026-08-17 13:00:00.000 UTC",
      "Time remaining: 1h",
    ].join("\n"),
  });
  const differentiated: ProviderCapacitySnapshot = {
    provider: "fixture-quota",
    state: "ready",
    models: { "gpt-5.5": { quota: { remaining: 9, limit: 100, used: 91 } } },
  };
  assert.equal(formatModelCapacity(differentiated, "gpt-5.5"), "Q 9/100");
  assert.equal(formatModelCapacityColored(theme, differentiated, "gpt-5.5"), "<error>Q 9/100</error>");
  assert.equal(formatStatuslineCapacityColored(theme, differentiated, "gpt-5.5"), "<error>Q 9/100</error>");
  assert.equal(formatCapacityDetails(differentiated, "gpt-5.5")?.title, "fixture-quota capacity");
});

test("Fixture Gateway details describe current model quota and load independently", () => {
  const snapshot: ProviderCapacitySnapshot = {
    provider: "fixture-gateway",
    state: "stale",
    models: {
      "fixture-model": {
        loadPercent: 113,
        quota: {
          remaining: 295,
          limit: 300,
          used: 5,
          resetsAt: (NOW + 86_400_000) / 1_000,
        },
      },
    },
  };
  assert.equal(formatModelCapacity(snapshot, "fixture-model"), "Q 295/300 · Load 113%");
  assert.equal(formatStatuslineCapacity(snapshot, "fixture-model", NOW), "98.3% · 1d L113% stale");
  const details = formatCapacityDetails(snapshot, "fixture-model", NOW);
  assert.equal(details?.title, "fixture-gateway capacity");
  assert.match(details?.body ?? "", /State: Stale/);
  assert.match(details?.body ?? "", /Quota remaining: 295 \/ 300/);
  assert.match(details?.body ?? "", /Time remaining: 1d/);
  assert.match(details?.body ?? "", /Load: 113%/);
});

test("neutral gateway-only data has a compact statusline, summary and details without brand dispatch", () => {
  const snapshot: ProviderCapacitySnapshot = {
    provider: "neutral-observer", state: "ready", gateway: { active: 2, maxActive: 8, queued: 3, backgroundActive: 1 },
  };
  assert.equal(formatStatuslineCapacity(snapshot, "model"), "Gateway 2/8 q3");
  assert.match(formatStatuslineCapacityColored(theme, snapshot, "model")!, /<muted>Gateway 2\/8<\/muted>/);
  assert.match(formatProviderCapacity(snapshot), /Gateway 2\/8 · Queue 3/);
  assert.match(formatCapacityDetails(snapshot, "model")!.body, /Gateway: 2 \/ 8\nQueue: 3\nBackground active: 1/);
  assert.equal(formatModelCapacity({ ...snapshot, models: { model: {} } }, "model"), undefined);
});

test("V2 accepts neutral provider shapes and rejects unknown versions, duplicates and malformed metrics", () => {
  const provider = {
    provider: "neutral-observer", state: "ready", observedAt: NOW,
    gateway: { active: 2, queued: 0, backgroundActive: 0 },
    models: { model: { observedAt: NOW, loadPercent: 130, quota: { remaining: 9, limit: 10, observedAt: NOW } } },
    windows: [{ kind: "other", label: "Account", usedPercent: 10, remainingPercent: 90 }],
    balances: [{ currency: "USD", remaining: 2 }],
  };
  const snapshot = { version: 2, ownerId: "fixture-owner", revision: 1, providers: [provider] };
  assert.ok(readModelCapacitySnapshot(snapshot));
  for (const version of [1, 3, undefined]) assert.equal(readModelCapacitySnapshot({ ...snapshot, version }), undefined);
  assert.equal(readModelCapacitySnapshot({ ...snapshot, ownerId: undefined }), undefined);
  assert.equal(readModelCapacitySnapshot({ ...snapshot, providers: [provider, provider] }), undefined);
  for (const models of [
    { model: { loadPercent: NaN } },
    { model: { observedAt: "bad" } },
    { model: { quota: { remaining: 11, limit: 10 } } },
    { model: { quota: { remaining: 1, limit: 10, observedAt: "bad" } } },
  ]) assert.equal(readModelCapacitySnapshot({ ...snapshot, providers: [{ ...provider, models }] }), undefined);
  const receipt = { version: 2, completedAt: NOW, providers: [{ provider: "neutral-observer", state: "ready", refreshed: true }] };
  assert.ok(readModelCapacityRefreshReceipt(receipt));
  assert.equal(readModelCapacityRefreshReceipt({ ...receipt, version: 1 }), undefined);
  assert.equal(readModelCapacityRefreshReceipt({ ...receipt, providers: [...receipt.providers, ...receipt.providers] }), undefined);
});

test("DeepSeek prepaid balance uses remaining money, not a quota window", () => {
  const snapshot: ProviderCapacitySnapshot = {
    provider: "deepseek",
    state: "ready",
    observedAt: NOW,
    balances: [{ currency: "CNY", remaining: 9.21, granted: 0, toppedUp: 9.21 }],
  };
  assert.equal(formatStatuslineCapacity(snapshot, "deepseek-v4-pro"), "¥9.21");
  assert.equal(formatStatuslineCapacityColored(theme, snapshot, "deepseek-v4-pro"), "<success>¥9.21</success>");
  assert.match(formatProviderCapacityColored(theme, snapshot, NOW), /<success>¥9\.21<\/success>/);
  assert.deepEqual(formatCapacityDetails(snapshot, "deepseek-v4-pro", NOW), {
    title: "deepseek capacity",
    body: [
      "Provider: deepseek",
      "State: Current",
      "Observed at: 2026-08-17 12:00:00.000 UTC",
      "",
      "Currency: CNY",
      "Remaining: ¥9.21",
      "Topped up: ¥9.21",
      "Granted: ¥0.00",
    ].join("\n"),
  });
  assert.equal(formatModelCapacity(snapshot, "deepseek-v4-pro"), undefined);
});
