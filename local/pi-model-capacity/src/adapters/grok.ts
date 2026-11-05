import type { CapacityAuthContext } from "./shared.ts";
import type { CapacityWindow, ProviderCapacitySnapshot } from "../contracts.ts";
import {
  officialBearerHeaders,
  clampPercent,
  fetchJson,
  finiteNumber,
  isRecord,
  requireOfficialOrigin,
  resolveProviderAuth,
  stringValue,
  type AdapterContext,
  type CapacityAdapter,
  type ResolvedCapacityAuth,
  withTimeout,
} from "./shared.ts";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

export interface GrokUsageSnapshot {
  window: CapacityWindow;
  onDemandCap?: number;
  onDemandUsed?: number;
  prepaidBalance?: number;
}

export function parseGrokUsage(payload: unknown): GrokUsageSnapshot | undefined {
  if (!isRecord(payload) || !isRecord(payload.config)) return undefined;
  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  if (!period) return undefined;
  const start = stringValue(period.start);
  const end = stringValue(period.end);
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return undefined;
  const rawUsage = finiteNumber(config.creditUsagePercent);
  const onDemandCap = moneyValue(config.onDemandCap);
  const onDemandUsed = moneyValue(config.onDemandUsed);
  const derivedUsage = onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined
    ? onDemandUsed / onDemandCap * 100
    : undefined;
  // The Grok credits schema uses proto-style omission for a zero scalar. A
  // valid current period plus no usage/cap therefore means exactly zero.
  const usedPercent = clampPercent(rawUsage ?? derivedUsage ?? 0);
  const periodType = stringValue(period?.type)?.toUpperCase();
  const durationSeconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1_000));
  return {
    window: {
      kind: periodType?.includes("WEEKLY") || near(durationSeconds, 7 * 86_400)
        ? "weekly"
        : "other",
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowSeconds: durationSeconds,
      resetsAt: Date.parse(end) / 1_000,
    },
    ...(onDemandCap !== undefined ? { onDemandCap } : {}),
    ...(onDemandUsed !== undefined ? { onDemandUsed } : {}),
    ...(moneyValue(config.prepaidBalance) !== undefined
      ? { prepaidBalance: moneyValue(config.prepaidBalance) }
      : {}),
  };
}

export function parseGrokSettings(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return stringValue(payload.subscription_tier_display)
    ?? (isRecord(payload.settings) ? stringValue(payload.settings.subscription_tier_display) : undefined);
}

function moneyValue(value: unknown): number | undefined {
  return isRecord(value) ? finiteNumber(value.val) : finiteNumber(value);
}

function near(value: number, target: number): boolean {
  return Math.abs(value - target) <= 3_600;
}

export const grokAdapter: CapacityAdapter = {
  provider: "xai",
  intervalMs: 30_000,
  staleMs: 90_000,
  resolveAuth(ctx: CapacityAuthContext) {
    return resolveProviderAuth(ctx, "xai", { oauthOnly: true });
  },
  async fetch(auth: ResolvedCapacityAuth, context: AdapterContext): Promise<Omit<ProviderCapacitySnapshot, "provider" | "state" | "observedAt" | "staleAfter">> {
    requireOfficialOrigin(auth.baseUrl, ["https://api.x.ai"], "Grok");
    const headers = {
      ...officialBearerHeaders(auth),
      "x-xai-token-auth": "xai-grok-cli",
    };
    const signal = withTimeout(context.signal, 10_000);
    const billingPayload = await fetchJson(context.fetch, BILLING_URL, {
      signal,
      headers,
    }, "Grok billing");
    const usage = parseGrokUsage(billingPayload);
    if (!usage) throw new Error("Grok billing response schema changed");
    let plan: string | undefined;
    try {
      const settingsPayload = await fetchJson(context.fetch, SETTINGS_URL, {
        signal,
        headers,
      }, "Grok settings");
      plan = parseGrokSettings(settingsPayload);
    } catch {
      // Plan enrichment must not hide already-valid quota data.
    }
    return {
      windows: [usage.window],
      ...(plan ? { plan } : {}),
    };
  },
};
