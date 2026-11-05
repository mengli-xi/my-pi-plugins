import type { CapacityAuthContext } from "./shared.ts";
import type { CapacityBalance, ProviderCapacitySnapshot } from "../contracts.ts";
import {
  fetchJson,
  isRecord,
  officialBearerHeaders,
  requireOfficialOrigin,
  resolveProviderAuth,
  stringValue,
  type AdapterContext,
  type CapacityAdapter,
  type ResolvedCapacityAuth,
  withTimeout,
} from "./shared.ts";

const BALANCE_URL = "https://api.deepseek.com/user/balance";

export function parseDeepSeekBalance(payload: unknown): { balances: CapacityBalance[] } {
  if (!isRecord(payload) || !Array.isArray(payload.balance_infos) || payload.balance_infos.length === 0) {
    throw new Error("DeepSeek balance response schema changed");
  }
  const balances: CapacityBalance[] = [];
  const seen = new Set<string>();
  for (const raw of payload.balance_infos) {
    if (!isRecord(raw)) throw new Error("DeepSeek balance entry is invalid");
    const currency = stringValue(raw.currency);
    if (!currency) throw new Error("DeepSeek balance currency is invalid");
    if (seen.has(currency)) throw new Error("DeepSeek balance currency is duplicated");
    seen.add(currency);
    const remaining = moneyValue(raw.total_balance);
    if (remaining === undefined) throw new Error("DeepSeek balance remaining is invalid");
    const granted = optionalMoney(raw.granted_balance);
    const toppedUp = optionalMoney(raw.topped_up_balance);
    balances.push({
      currency,
      remaining,
      ...(granted === undefined ? {} : { granted }),
      ...(toppedUp === undefined ? {} : { toppedUp }),
    });
  }
  return { balances };
}

function moneyValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function optionalMoney(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = moneyValue(value);
  if (number === undefined) throw new Error("DeepSeek balance amount is invalid");
  return number;
}

export const deepseekAdapter: CapacityAdapter = {
  provider: "deepseek",
  intervalMs: 30_000,
  staleMs: 90_000,
  resolveAuth(ctx: CapacityAuthContext) {
    return resolveProviderAuth(ctx, "deepseek");
  },
  async fetch(auth: ResolvedCapacityAuth, context: AdapterContext): Promise<Omit<ProviderCapacitySnapshot, "provider" | "state" | "observedAt" | "staleAfter">> {
    requireOfficialOrigin(auth.baseUrl, ["https://api.deepseek.com"], "DeepSeek");
    const payload = await fetchJson(context.fetch, BALANCE_URL, {
      signal: withTimeout(context.signal, 10_000),
      headers: officialBearerHeaders(auth),
    }, "DeepSeek balance");
    return parseDeepSeekBalance(payload);
  },
};
