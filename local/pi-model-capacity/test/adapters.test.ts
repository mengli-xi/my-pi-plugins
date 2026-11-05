import assert from "node:assert/strict";
import test from "node:test";
import { codexAdapter, extractCodexAccountId, parseCodexUsage } from "../src/adapters/codex.ts";
import { deepseekAdapter, parseDeepSeekBalance } from "../src/adapters/deepseek.ts";
import { grokAdapter, parseGrokSettings, parseGrokUsage } from "../src/adapters/grok.ts";
import { fetchJson } from "../src/adapters/shared.ts";

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("public adapter cadences keep subscription endpoints bounded", () => {
  assert.equal(codexAdapter.intervalMs, 30_000);
  assert.equal(grokAdapter.intervalMs, 30_000);
  assert.equal(deepseekAdapter.intervalMs, 30_000);
});

test("Codex classifies primary and secondary windows by duration, not position", () => {
  const snapshot = parseCodexUsage({
    plan_type: "pro",
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 100 },
      secondary_window: { used_percent: 34, limit_window_seconds: 604_800, reset_at: 200 },
    },
    additional_rate_limits: [{
      limit_name: "Spark",
      rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } },
    }],
  });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.windows.map((window) => window.kind), ["five_hour", "seven_day"]);
  assert.deepEqual(snapshot.windows.map((window) => window.remainingPercent), [88, 66]);
  assert.equal(snapshot.extra[0]?.windows[0]?.label, "Spark");
});

test("Codex accepts a weekly-only plan and rejects a meter without usable windows", () => {
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: {} } }), undefined);
  const snapshot = parseCodexUsage({
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 604_800 } },
  });
  assert.equal(snapshot?.windows[0]?.kind, "seven_day");
});

test("Codex account id comes only from the OAuth claim", () => {
  assert.equal(extractCodexAccountId(jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })), "acct-1");
  assert.equal(extractCodexAccountId("not-a-jwt"), undefined);
});

test("Grok treats omitted proto scalar as zero only with a valid current period", () => {
  const zero = parseGrokUsage({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-15T16:00:00Z",
        end: "2026-08-22T16:00:00Z",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
    },
  });
  assert.equal(zero?.window.usedPercent, 0);
  assert.equal(zero?.window.kind, "weekly");
  assert.equal(parseGrokUsage({ config: { creditUsagePercent: 0 } }), undefined);
  assert.equal(parseGrokUsage({ config: {
    billingPeriodStart: "2026-08-15T16:00:00Z",
    billingPeriodEnd: "2026-08-22T16:00:00Z",
  } }), undefined, "fallback dates alone cannot prove an omitted usage scalar is zero");
});

test("Grok derives usage from on-demand values and parses optional settings", () => {
  const snapshot = parseGrokUsage({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-15T16:00:00Z",
        end: "2026-08-22T16:00:00Z",
      },
      onDemandCap: { val: 200 },
      onDemandUsed: { val: 50 },
    },
  });
  assert.equal(snapshot?.window.usedPercent, 25);
  assert.equal(parseGrokSettings({ subscription_tier_display: "SuperGrok Heavy" }), "SuperGrok Heavy");
});

test("official subscription endpoints do not receive provider proxy headers", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, headers });
    if (url.includes("wham/usage")) {
      return Response.json({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604_800 } } });
    }
    if (url.includes("/v1/settings")) return Response.json({ subscription_tier_display: "SuperGrok" });
    if (url.includes("/user/balance")) {
      return Response.json({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "9.21", granted_balance: "0.00", topped_up_balance: "9.21" }],
      });
    }
    return Response.json({ config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-15T16:00:00Z", end: "2026-08-22T16:00:00Z" },
    } });
  };
  const signal = new AbortController().signal;
  await codexAdapter.fetch({
    apiKey: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }),
    baseUrl: "https://chatgpt.com/backend-api",
    headers: { "x-proxy-secret": "do-not-send" },
    fingerprint: "codex",
  }, { ctx: {} as never, fetch: fetcher as typeof fetch, now: Date.now, signal });
  await grokAdapter.fetch({
    apiKey: "oauth-token",
    baseUrl: "https://api.x.ai/v1",
    headers: { "x-proxy-secret": "do-not-send" },
    fingerprint: "grok",
  }, { ctx: {} as never, fetch: fetcher as typeof fetch, now: Date.now, signal });
  await deepseekAdapter.fetch({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    headers: { "x-proxy-secret": "do-not-send" },
    fingerprint: "deepseek",
  }, { ctx: {} as never, fetch: fetcher as typeof fetch, now: Date.now, signal });
  assert.ok(seen.every(({ headers }) => !headers.has("x-proxy-secret")));
  assert.equal(seen.find(({ url }) => url.includes("/v1/billing"))?.headers.get("x-xai-token-auth"), "xai-grok-cli");
});

test("bounded JSON reading rejects a streamed body without Content-Length", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(200_000));
      controller.enqueue(new Uint8Array(100_000));
      controller.close();
    },
  });
  const fetcher = async (): Promise<Response> => new Response(body, { status: 200 });
  await assert.rejects(() => fetchJson(fetcher as typeof fetch, "https://example.invalid", {}, "fixture"), /too large/);
});

test("DeepSeek parses official prepaid wallet fields and rejects a consumed quota invention", () => {
  assert.deepEqual(parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{
      currency: "CNY",
      total_balance: "9.21",
      granted_balance: "0.00",
      topped_up_balance: "9.21",
    }],
  }), {
    balances: [{ currency: "CNY", remaining: 9.21, granted: 0, toppedUp: 9.21 }],
  });
  assert.throws(() => parseDeepSeekBalance({ is_available: true, balance_infos: [] }), /schema changed/);
  assert.throws(() => parseDeepSeekBalance({
    balance_infos: [{ currency: "CNY", total_balance: "-1.00" }],
  }), /remaining is invalid/);
});

test("official subscription adapters reject custom provider origins before fetch", async () => {
  let fetched = false;
  const fetcher = async (): Promise<Response> => { fetched = true; return Response.json({}); };
  await assert.rejects(() => grokAdapter.fetch({
    apiKey: "oauth-token",
    baseUrl: "https://proxy.example/v1",
    headers: {},
    fingerprint: "grok",
  }, {
    ctx: {} as never,
    fetch: fetcher as typeof fetch,
    now: Date.now,
    signal: new AbortController().signal,
  }), /custom provider base URL/);
  await assert.rejects(() => deepseekAdapter.fetch({
    apiKey: "sk-test",
    baseUrl: "https://proxy.example/v1",
    headers: {},
    fingerprint: "deepseek",
  }, {
    ctx: {} as never,
    fetch: fetcher as typeof fetch,
    now: Date.now,
    signal: new AbortController().signal,
  }), /custom provider base URL/);
  assert.equal(fetched, false);
});
