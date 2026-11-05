import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapacityProviderId, ProviderCapacitySnapshot } from "../contracts.ts";

/** Capacity adapters can observe configuration/auth only; no completion or tool execution port. */
export interface CapacityAuthContext {
  modelRegistry: Pick<ExtensionContext["modelRegistry"],
    "getProviderAuthStatus" | "getAvailable" | "getAll" | "isUsingOAuth" | "getProviderAuth"> & {
      getProvider(provider: string): { baseUrl?: string } | undefined;
    };
}

export function capacityContext(ctx: ExtensionContext): CapacityAuthContext {
  const registry = ctx.modelRegistry;
  const methods = ["getProviderAuthStatus", "getAvailable", "getAll", "isUsingOAuth", "getProviderAuth"] as const;
  const projection: Record<string, unknown> = {};
  for (const method of methods) {
    if (typeof registry?.[method] === "function") projection[method] = registry[method].bind(registry);
  }
  projection.getProvider = (provider: string) => {
    const value = registry?.getProvider(provider);
    return value ? { baseUrl: value.baseUrl } : undefined;
  };
  return Object.freeze({ modelRegistry: Object.freeze(projection) }) as unknown as CapacityAuthContext;
}

export interface ResolvedCapacityAuth {
  apiKey: string;
  baseUrl?: string;
  headers: Record<string, string>;
  fingerprint: string;
  prepared?: unknown;
}

export interface AdapterContext {
  ctx: CapacityAuthContext;
  fetch: typeof globalThis.fetch;
  now(): number;
  signal: AbortSignal;
}

export interface CapacityAdapter {
  provider: CapacityProviderId;
  intervalMs: number;
  staleMs: number;
  resolveAuth(ctx: CapacityAuthContext, signal?: AbortSignal): Promise<ResolvedCapacityAuth | undefined>;
  fetch(auth: ResolvedCapacityAuth, context: AdapterContext): Promise<Omit<ProviderCapacitySnapshot, "provider" | "state" | "staleAfter">>;
}

export async function resolveProviderAuth(
  ctx: CapacityAuthContext,
  provider: CapacityProviderId,
  options: { oauthOnly?: boolean } = {},
): Promise<ResolvedCapacityAuth | undefined> {
  if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) return undefined;
  if (options.oauthOnly) {
    const model = ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === provider)
      ?? ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider);
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return undefined;
  }
  const result = await ctx.modelRegistry.getProviderAuth(provider);
  const auth = result?.auth;
  const apiKey = auth?.apiKey?.trim();
  if (!auth || !apiKey) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers[key] = value;
  }
  return {
    apiKey,
    baseUrl: auth.baseUrl ?? ctx.modelRegistry.getProvider(provider)?.baseUrl,
    headers,
    fingerprint: authFingerprint(
      provider,
      apiKey,
      auth.baseUrl ?? ctx.modelRegistry.getProvider(provider)?.baseUrl,
      headers,
    ),
  };
}

export function authFingerprint(
  provider: string,
  apiKey: string,
  baseUrl: string | undefined,
  headers: Record<string, string>,
): string {
  const hash = createHash("sha256");
  hash.update(provider);
  hash.update("\0");
  hash.update(apiKey);
  hash.update("\0");
  hash.update(baseUrl ?? "");
  for (const [key, value] of Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update("\0");
    hash.update(key.toLowerCase());
    hash.update("\0");
    hash.update(value);
  }
  return hash.digest("hex");
}

export async function fetchJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  options: RequestInit,
  label: string,
): Promise<unknown> {
  const response = await fetcher(url, options);
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 256 * 1024) {
    throw new Error(`${label} response is too large`);
  }
  const text = await readBoundedText(response, 256 * 1024, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function bearerHeaders(auth: ResolvedCapacityAuth): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(auth.headers).filter(([key]) => key.toLowerCase() !== "authorization"),
  );
  return {
    ...headers,
    authorization: `Bearer ${auth.apiKey}`,
    accept: "application/json",
  };
}

/** Official usage endpoints receive only the resolved bearer, never proxy headers. */
export function officialBearerHeaders(auth: ResolvedCapacityAuth): Record<string, string> {
  return {
    authorization: `Bearer ${auth.apiKey}`,
    accept: "application/json",
  };
}

export function requireOfficialOrigin(
  baseUrl: string | undefined,
  allowedOrigins: readonly string[],
  label: string,
): void {
  if (!baseUrl) return;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error(`${label} provider base URL is invalid`);
  }
  if (!allowedOrigins.includes(origin)) {
    throw new Error(`${label} usage refuses a credential resolved for a custom provider base URL`);
  }
}

export function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

export function nonNegativeInteger(value: unknown): number | undefined {
  const number = nonNegativeNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function readBoundedText(response: Response, limit: number, label: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(`${label} response is too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
