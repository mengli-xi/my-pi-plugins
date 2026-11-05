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

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOURS_SECONDS = 18_000;
const SEVEN_DAYS_SECONDS = 604_800;

export interface CodexUsageSnapshot {
  planType?: string;
  limitReached: boolean;
  windows: CapacityWindow[];
  extra: Array<{ name: string; windows: CapacityWindow[] }>;
}

export function parseCodexUsage(payload: unknown): CodexUsageSnapshot | undefined {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return undefined;
  const windows = parseRateLimitWindows(payload.rate_limit);
  if (windows.length === 0) return undefined;
  const extra: CodexUsageSnapshot["extra"] = [];
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const raw of payload.additional_rate_limits) {
      if (!isRecord(raw)) continue;
      const name = stringValue(raw.limit_name) ?? stringValue(raw.title);
      if (!name) continue;
      const holder = isRecord(raw.rate_limit) ? raw.rate_limit : raw;
      const extraWindows = parseRateLimitWindows(holder, name);
      if (extraWindows.length > 0) extra.push({ name, windows: extraWindows });
    }
  }
  return {
    planType: stringValue(payload.plan_type),
    limitReached: payload.rate_limit.limit_reached === true,
    windows,
    extra,
  };
}

function parseRateLimitWindows(holder: Record<string, unknown>, label?: string): CapacityWindow[] {
  const windows: CapacityWindow[] = [];
  for (const key of ["primary_window", "secondary_window", "tertiary_window"] as const) {
    const parsed = parseWindow(holder[key], label);
    if (parsed) windows.push(parsed);
  }
  return windows;
}

function parseWindow(value: unknown, label?: string): CapacityWindow | undefined {
  if (!isRecord(value)) return undefined;
  const used = finiteNumber(value.used_percent);
  if (used === undefined) return undefined;
  const windowSeconds = finiteNumber(value.limit_window_seconds);
  const resetsAt = finiteNumber(value.reset_at);
  const usedPercent = clampPercent(used);
  return {
    kind: windowSeconds === FIVE_HOURS_SECONDS
      ? "five_hour"
      : windowSeconds === SEVEN_DAYS_SECONDS
        ? "seven_day"
        : "other",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(windowSeconds !== undefined && windowSeconds > 0 ? { windowSeconds } : {}),
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
    ...(label ? { label } : {}),
  };
}

export function extractCodexAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export const codexAdapter: CapacityAdapter = {
  provider: "openai-codex",
  intervalMs: 30_000,
  staleMs: 90_000,
  resolveAuth(ctx: CapacityAuthContext) {
    return resolveProviderAuth(ctx, "openai-codex", { oauthOnly: true });
  },
  async fetch(auth: ResolvedCapacityAuth, context: AdapterContext): Promise<Omit<ProviderCapacitySnapshot, "provider" | "state" | "observedAt" | "staleAfter">> {
    requireOfficialOrigin(auth.baseUrl, ["https://chatgpt.com"], "Codex");
    const accountId = extractCodexAccountId(auth.apiKey);
    if (!accountId) throw new Error("Codex OAuth account id is unavailable");
    const payload = await fetchJson(context.fetch, USAGE_URL, {
      signal: withTimeout(context.signal, 10_000),
      headers: {
        ...officialBearerHeaders(auth),
        "chatgpt-account-id": accountId,
        originator: "pi",
      },
    }, "Codex usage");
    const parsed = parseCodexUsage(payload);
    if (!parsed) throw new Error("Codex usage response schema changed");
    const extraWindows = parsed.extra.flatMap(({ name, windows }) =>
      windows.map((window) => ({ ...window, label: name })));
    return {
      windows: [...parsed.windows, ...extraWindows],
      ...(parsed.planType ? { plan: parsed.planType } : {}),
    };
  },
};
