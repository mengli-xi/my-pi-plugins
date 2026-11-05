export const MODEL_CAPACITY_SNAPSHOT_CHANNEL = "model-capacity:snapshot-v2";
export const MODEL_CAPACITY_REQUEST_CHANNEL = "model-capacity:request-snapshot-v2";
export const MODEL_CAPACITY_WATCH_CHANNEL = "model-capacity:watch-v2";
export const MODEL_CAPACITY_REGISTER_CHANNEL = "model-capacity:register-adapter-v1";
export const MODEL_CAPACITY_READY_CHANNEL = "model-capacity:adapter-ready-v1";

export type CapacityProviderId = string;
export type CapacityState = "refreshing" | "ready" | "stale" | "unavailable" | "error";
export type CapacityWindowKind = "five_hour" | "seven_day" | "weekly" | "other";

export interface CapacityWindow {
  kind: CapacityWindowKind;
  usedPercent: number;
  remainingPercent: number;
  windowSeconds?: number;
  resetsAt?: number;
  label?: string;
}

export interface GatewayCapacity {
  active: number;
  queued: number;
  backgroundActive: number;
  maxActive?: number;
}

export interface ModelQuota {
  observedAt?: number;
  remaining: number;
  limit: number;
  used?: number;
  resetsAt?: number;
}

export interface CapacityBalance {
  currency: string;
  remaining: number;
  granted?: number;
  toppedUp?: number;
}

export interface ModelCapacity {
  /** Source time of load metrics (or quota alone when no load is known), in milliseconds. */
  observedAt?: number;
  loadPercent?: number;
  queueSize?: number;
  outputQpm?: number;
  totalQpm?: number;
  quota?: ModelQuota;
}

export interface ProviderCapacitySnapshot {
  provider: CapacityProviderId;
  state: CapacityState;
  observedAt?: number;
  staleAfter?: number;
  error?: string;
  plan?: string;
  windows?: CapacityWindow[];
  gateway?: GatewayCapacity;
  models?: Record<string, ModelCapacity>;
  balances?: CapacityBalance[];
}

export interface ModelCapacitySnapshotV2 {
  version: 2;
  ownerId: string;
  revision: number;
  sessionId?: string;
  providers: ProviderCapacitySnapshot[];
}

export interface ProviderRefreshReceipt {
  provider: CapacityProviderId;
  refreshed: boolean;
  state: CapacityState;
  observedAt?: number;
  error?: string;
}

export interface ModelCapacityRefreshReceiptV2 {
  version: 2;
  completedAt: number;
  providers: ProviderRefreshReceipt[];
}

export interface ModelCapacityRequestV2 {
  version: 2;
  sessionId?: string;
  /** Omitted preserves the synchronous cached-snapshot request semantics. */
  refreshProviders?: CapacityProviderId[];
  reply(snapshot: ModelCapacitySnapshotV2, refresh?: ModelCapacityRefreshReceiptV2): void;
}

export interface ModelCapacityWatchV2 {
  version: 2;
  watcherId: string;
  action: "acquire" | "release";
  sessionId?: string;
  /** Omitted means all providers; statusline scopes this to the current provider. */
  providers?: CapacityProviderId[];
}

export function isCapacityProviderId(value: unknown): value is CapacityProviderId {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

export function readCapacityRequest(value: unknown): ModelCapacityRequestV2 | undefined {
  if (!isRecord(value) || value.version !== 2 || typeof value.reply !== "function") return undefined;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
  if (value.refreshProviders !== undefined && (
    !Array.isArray(value.refreshProviders)
    || value.refreshProviders.length === 0
    || !value.refreshProviders.every(isCapacityProviderId)
  )) return undefined;
  return value as unknown as ModelCapacityRequestV2;
}

export function readCapacityWatch(value: unknown): ModelCapacityWatchV2 | undefined {
  if (!isRecord(value) || value.version !== 2 || typeof value.watcherId !== "string" || !value.watcherId) {
    return undefined;
  }
  if (value.action !== "acquire" && value.action !== "release") return undefined;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
  if (value.providers !== undefined && (
    !Array.isArray(value.providers)
    || value.providers.length === 0
    || !value.providers.every(isCapacityProviderId)
  )) return undefined;
  return value as unknown as ModelCapacityWatchV2;
}

export function isModelCapacitySnapshot(value: unknown): value is ModelCapacitySnapshotV2 {
  if (!isRecord(value) || value.version !== 2 || !isNonNegativeInteger(value.revision) || !Array.isArray(value.providers)) {
    return false;
  }
  if (typeof value.ownerId !== "string" || !value.ownerId) return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return false;
  return value.providers.every(readProviderSnapshot)
    && new Set(value.providers.map((provider) => provider.provider)).size === value.providers.length;
}

export function readProviderSnapshot(value: unknown): value is ProviderCapacitySnapshot {
  if (!isRecord(value) || !isCapacityProviderId(value.provider)) return false;
  if (!["refreshing", "ready", "stale", "unavailable", "error"].includes(String(value.state))) return false;
  if (value.observedAt !== undefined && !isFiniteNumber(value.observedAt)) return false;
  if (value.staleAfter !== undefined && !isFiniteNumber(value.staleAfter)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.plan !== undefined && typeof value.plan !== "string") return false;
  if (value.windows !== undefined && (!Array.isArray(value.windows) || !value.windows.every(readWindow))) return false;
  if (value.gateway !== undefined && !readGateway(value.gateway)) return false;
  if (value.models !== undefined && !readModels(value.models)) return false;
  if (value.balances !== undefined && !readBalances(value.balances)) return false;
  return true;
}

function readWindow(value: unknown): boolean {
  if (!isRecord(value) || !["five_hour", "seven_day", "weekly", "other"].includes(String(value.kind))) return false;
  if (!isFiniteNumber(value.usedPercent) || !isFiniteNumber(value.remainingPercent)) return false;
  if (value.windowSeconds !== undefined && !isFiniteNumber(value.windowSeconds)) return false;
  if (value.resetsAt !== undefined && !isFiniteNumber(value.resetsAt)) return false;
  return value.label === undefined || typeof value.label === "string";
}

function readGateway(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.active) && isFiniteNumber(value.queued)
    && isFiniteNumber(value.backgroundActive)
    && (value.maxActive === undefined || isFiniteNumber(value.maxActive));
}

function readModels(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((model) => {
    if (!isRecord(model)) return false;
    if (model.observedAt !== undefined && !isFiniteNumber(model.observedAt)) return false;
    if (!["loadPercent", "queueSize", "outputQpm", "totalQpm"].every((key) =>
      model[key] === undefined || isFiniteNumber(model[key]))) return false;
    return model.quota === undefined || readModelQuota(model.quota);
  });
}

function readModelQuota(value: unknown): boolean {
  if (!isRecord(value) || !isFiniteNumber(value.remaining) || !isFiniteNumber(value.limit)) return false;
  if (value.limit <= 0 || value.remaining < 0 || value.remaining > value.limit) return false;
  if (value.observedAt !== undefined && !isFiniteNumber(value.observedAt)) return false;
  if (value.used !== undefined && (!isFiniteNumber(value.used) || value.used < 0 || value.used > value.limit)) return false;
  return value.resetsAt === undefined || isFiniteNumber(value.resetsAt) && value.resetsAt > 0;
}

function readBalances(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(readBalance);
}

function readBalance(value: unknown): boolean {
  if (!isRecord(value) || typeof value.currency !== "string" || !value.currency.trim()) return false;
  if (!isFiniteNumber(value.remaining) || value.remaining < 0) return false;
  if (value.granted !== undefined && (!isFiniteNumber(value.granted) || value.granted < 0)) return false;
  return value.toppedUp === undefined || isFiniteNumber(value.toppedUp) && value.toppedUp >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
