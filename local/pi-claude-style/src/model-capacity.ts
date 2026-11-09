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

export function isCapacityProviderId(value: unknown): value is CapacityProviderId {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}
const STATES = new Set<CapacityState>(["refreshing", "ready", "stale", "unavailable", "error"]);
const WINDOW_KINDS = new Set<CapacityWindowKind>(["five_hour", "seven_day", "weekly", "other"]);

export function readModelCapacitySnapshot(value: unknown): ModelCapacitySnapshotV2 | undefined {
  if (!isRecord(value) || value.version !== 2 || !nonNegativeInteger(value.revision) || !Array.isArray(value.providers)) {
    return undefined;
  }
  if (typeof value.ownerId !== "string" || !value.ownerId) return undefined;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
  if (!value.providers.every(validProvider)) return undefined;
  if (new Set(value.providers.map((entry) => entry.provider)).size !== value.providers.length) return undefined;
  return value as unknown as ModelCapacitySnapshotV2;
}

export function readModelCapacityRefreshReceipt(value: unknown): ModelCapacityRefreshReceiptV2 | undefined {
  if (!isRecord(value) || value.version !== 2 || !finite(value.completedAt) || value.completedAt < 0
    || !Array.isArray(value.providers) || value.providers.length === 0) return undefined;
  if (!value.providers.every(validRefreshReceipt)) return undefined;
  const providers = value.providers.map((entry) => (entry as { provider: CapacityProviderId }).provider);
  if (new Set(providers).size !== providers.length) return undefined;
  return value as unknown as ModelCapacityRefreshReceiptV2;
}

export function providerCapacity(
  snapshot: ModelCapacitySnapshotV2 | undefined,
  provider: string | undefined,
): ProviderCapacitySnapshot | undefined {
  if (!snapshot || !isCapacityProviderId(provider)) return undefined;
  return snapshot.providers.find((entry) => entry.provider === provider);
}

interface CapacityTheme {
  fg(color: "dim" | "muted" | "success" | "warning" | "error", text: string): string;
}

function quotaTone(remainingPercent: number): "success" | "warning" | "error" {
  if (remainingPercent <= 10) return "error";
  if (remainingPercent <= 20) return "warning";
  return "success";
}

function colorQuota(theme: CapacityTheme, text: string, remainingPercent: number): string {
  return theme.fg(quotaTone(remainingPercent), text);
}

export function formatProviderCapacity(
  snapshot: ProviderCapacitySnapshot | undefined,
  now = Date.now(),
): string {
  if (!snapshot) return "Capacity unavailable";
  const parts: string[] = [];
  if (snapshot.plan) parts.push(sanitize(snapshot.plan));
  if (snapshot.gateway) {
    const max = snapshot.gateway.maxActive === undefined ? "?" : formatNumber(snapshot.gateway.maxActive);
    parts.push(`Gateway ${formatNumber(snapshot.gateway.active)}/${max}`);
    parts.push(`Queue ${formatNumber(snapshot.gateway.queued)}`);
  }
  for (const window of accountWindows(snapshot.windows)) {
    parts.push(`${summaryWindowLabel(window)} ${formatPercent(window.remainingPercent)} left`);
  }
  for (const balance of snapshot.balances ?? []) {
    parts.push(formatCurrencyAmount(balance.currency, balance.remaining));
  }
  if (snapshot.state === "refreshing") {
    parts.push(parts.length === 0 ? "Refreshing capacity…" : "refreshing…");
  } else if (snapshot.state === "stale") {
    parts.push(snapshot.observedAt === undefined ? "stale" : `stale ${formatAge(now - snapshot.observedAt)}`);
  } else if (snapshot.state === "ready") {
    parts.push(snapshot.observedAt === undefined ? "updated" : `updated ${formatAge(now - snapshot.observedAt)}`);
  } else if (parts.length === 0) {
    parts.push("Capacity unavailable");
  }
  return parts.join(" · ");
}

export function formatProviderCapacityColored(
  theme: CapacityTheme,
  snapshot: ProviderCapacitySnapshot | undefined,
  now = Date.now(),
): string {
  if (!snapshot) return theme.fg("dim", "Capacity unavailable");
  const parts: string[] = [];
  if (snapshot.plan) parts.push(theme.fg("muted", sanitize(snapshot.plan)));
  if (snapshot.gateway) {
    const max = snapshot.gateway.maxActive === undefined ? "?" : formatNumber(snapshot.gateway.maxActive);
    parts.push(theme.fg("muted", `Gateway ${formatNumber(snapshot.gateway.active)}/${max}`));
    parts.push(theme.fg("muted", `Queue ${formatNumber(snapshot.gateway.queued)}`));
  }
  for (const window of accountWindows(snapshot.windows)) {
    parts.push(colorQuota(theme, `${summaryWindowLabel(window)} ${formatPercent(window.remainingPercent)} left`, window.remainingPercent));
  }
  for (const balance of snapshot.balances ?? []) {
    parts.push(colorBalance(theme, formatCurrencyAmount(balance.currency, balance.remaining), balance.remaining));
  }
  if (snapshot.state === "refreshing") {
    parts.push(theme.fg("dim", parts.length === 0 ? "Refreshing capacity…" : "refreshing…"));
  } else if (snapshot.state === "stale") {
    parts.push(theme.fg("warning", snapshot.observedAt === undefined ? "stale" : `stale ${formatAge(now - snapshot.observedAt)}`));
  } else if (snapshot.state === "ready") {
    parts.push(theme.fg("dim", snapshot.observedAt === undefined ? "updated" : `updated ${formatAge(now - snapshot.observedAt)}`));
  } else if (parts.length === 0) {
    parts.push(theme.fg("dim", "Capacity unavailable"));
  }
  return parts.join(theme.fg("dim", " · "));
}

export function formatModelCapacity(
  snapshot: ProviderCapacitySnapshot | undefined,
  modelId: string,
): string | undefined {
  const model = snapshot?.models?.[modelId];
  if (!model) return undefined;
  const parts: string[] = [];
  if (model.quota) parts.push(`Q ${formatNumber(model.quota.remaining)}/${formatNumber(model.quota.limit)}`);
  if (model.loadPercent !== undefined) parts.push(`Load ${formatLoadPercent(model.loadPercent)}`);
  if (model.queueSize !== undefined) parts.push(`q${formatNumber(model.queueSize)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatModelCapacityColored(
  theme: CapacityTheme,
  snapshot: ProviderCapacitySnapshot | undefined,
  modelId: string,
): string | undefined {
  const model = snapshot?.models?.[modelId];
  if (!model) return undefined;
  const parts: string[] = [];
  if (model.quota) {
    const remainingPercent = model.quota.limit > 0 ? model.quota.remaining / model.quota.limit * 100 : 0;
    parts.push(colorQuota(theme, `Q ${formatNumber(model.quota.remaining)}/${formatNumber(model.quota.limit)}`, remainingPercent));
  }
  if (model.loadPercent !== undefined) parts.push(theme.fg("muted", `Load ${formatLoadPercent(model.loadPercent)}`));
  if (model.queueSize !== undefined) parts.push(theme.fg("muted", `q${formatNumber(model.queueSize)}`));
  return parts.length > 0 ? parts.join(theme.fg("dim", " · ")) : undefined;
}

/** Compact current-model/provider segment for statusline presentation. */
export function formatStatuslineCapacity(
  snapshot: ProviderCapacitySnapshot | undefined,
  modelId: string,
  now = Date.now(),
): string | undefined {
  if (!snapshot || snapshot.state === "unavailable" || snapshot.state === "error") return undefined;
  const parts: string[] = [];
  {
    const model = snapshot.models?.[modelId];
    if (model?.quota) {
      const remainingPercent = model.quota.limit > 0 ? model.quota.remaining / model.quota.limit * 100 : 0;
      parts.push(model.quota.resetsAt === undefined
        ? `Q ${formatNumber(model.quota.remaining)}/${formatNumber(model.quota.limit)}`
        : statuslineResetQuota(remainingPercent, model.quota.resetsAt, now));
    }
    if (model?.loadPercent !== undefined) parts.push(`L${formatLoadPercent(model.loadPercent)}`);
  }
  {
    for (const balance of snapshot.balances ?? []) {
      parts.push(formatCurrencyAmount(balance.currency, balance.remaining));
    }
    for (const window of accountWindows(snapshot.windows)) {
      parts.push(window.resetsAt === undefined
        ? `${statuslineWindowLabel(window)}${formatPercent(window.remainingPercent)}`
        : statuslineResetQuota(window.remainingPercent, window.resetsAt, now));
    }
  }
  if (parts.length === 0 && snapshot.gateway) {
    const gateway = snapshot.gateway;
    parts.push(`Gateway ${formatNumber(gateway.active)}/${gateway.maxActive === undefined ? "?" : formatNumber(gateway.maxActive)}`);
    if (gateway.queued > 0) parts.push(`q${formatNumber(gateway.queued)}`);
  }
  if (parts.length === 0) return undefined;
  if (snapshot.state === "stale") parts.push("stale");
  return parts.join(" ");
}

export function formatStatuslineCapacityColored(
  theme: CapacityTheme,
  snapshot: ProviderCapacitySnapshot | undefined,
  modelId: string,
  now = Date.now(),
): string | undefined {
  if (!snapshot || snapshot.state === "unavailable" || snapshot.state === "error") return undefined;
  const parts: string[] = [];
  {
    const model = snapshot.models?.[modelId];
    if (model?.quota) {
      const remainingPercent = model.quota.limit > 0 ? model.quota.remaining / model.quota.limit * 100 : 0;
      parts.push(model.quota.resetsAt === undefined
        ? colorQuota(theme, `Q ${formatNumber(model.quota.remaining)}/${formatNumber(model.quota.limit)}`, remainingPercent)
        : statuslineResetQuotaColored(theme, remainingPercent, model.quota.resetsAt, now));
    }
    if (model?.loadPercent !== undefined) {
      parts.push(theme.fg("muted", `L${formatLoadPercent(model.loadPercent)}`));
    }
  }
  {
    for (const balance of snapshot.balances ?? []) {
      parts.push(colorBalance(theme, formatCurrencyAmount(balance.currency, balance.remaining), balance.remaining));
    }
    for (const window of accountWindows(snapshot.windows)) {
      parts.push(window.resetsAt === undefined
        ? colorQuota(theme, `${statuslineWindowLabel(window)}${formatPercent(window.remainingPercent)}`, window.remainingPercent)
        : statuslineResetQuotaColored(theme, window.remainingPercent, window.resetsAt, now));
    }
  }
  if (parts.length === 0 && snapshot.gateway) {
    const gateway = snapshot.gateway;
    parts.push(theme.fg("muted", `Gateway ${formatNumber(gateway.active)}/${gateway.maxActive === undefined ? "?" : formatNumber(gateway.maxActive)}`));
    if (gateway.queued > 0) parts.push(theme.fg("muted", `q${formatNumber(gateway.queued)}`));
  }
  if (parts.length === 0) return undefined;
  if (snapshot.state === "stale") parts.push(theme.fg("warning", "stale"));
  return parts.join(" ");
}

export interface CapacityDetails {
  title: string;
  body: string;
}

/** Full click-through detail for the compact statusline capacity segment. */
export function formatCapacityDetails(
  snapshot: ProviderCapacitySnapshot | undefined,
  modelId: string,
  now = Date.now(),
): CapacityDetails | undefined {
  if (!snapshot || snapshot.state === "unavailable" || snapshot.state === "error") return undefined;
  const state = snapshot.state === "stale" ? "Stale" : snapshot.state === "refreshing" ? "Refreshing" : "Current";
  const observed = snapshot.observedAt === undefined ? undefined : formatExactTime(snapshot.observedAt);
  const model = snapshot.models?.[modelId];
  const windows = detailWindows(snapshot.windows);
  if (!model && !snapshot.gateway && !snapshot.balances?.length && !windows.length) return undefined;
  const providerName = providerLabel(snapshot.provider);
  const lines = [
    `Provider: ${providerName}`,
    ...(snapshot.plan ? [`Plan: ${sanitize(snapshot.plan)}`] : []),
    `State: ${state}`,
    ...(observed ? [`Observed at: ${observed}`] : []),
  ];
  if (snapshot.gateway) {
    const gateway = snapshot.gateway;
    lines.push("", `Gateway: ${formatNumber(gateway.active)} / ${gateway.maxActive === undefined ? "?" : formatNumber(gateway.maxActive)}`,
      `Queue: ${formatNumber(gateway.queued)}`, `Background active: ${formatNumber(gateway.backgroundActive)}`);
  }
  if (model) {
    lines.push("", `Model: ${modelId}`);
    if (model.quota) {
      lines.push(
        `Quota remaining: ${formatNumber(model.quota.remaining)} / ${formatNumber(model.quota.limit)}`,
        ...(model.quota.used === undefined ? [] : [`Quota used: ${formatNumber(model.quota.used)} / ${formatNumber(model.quota.limit)}`]),
        ...resetDetails(model.quota.resetsAt, now),
      );
    }
    if (model.loadPercent !== undefined) lines.push(`Load: ${formatLoadPercent(model.loadPercent)}`);
    if (model.queueSize !== undefined) lines.push(`Queue: ${formatNumber(model.queueSize)}`);
    if (model.outputQpm !== undefined) lines.push(`Output QPM: ${formatNumber(model.outputQpm)}`);
    if (model.totalQpm !== undefined) lines.push(`Total QPM: ${formatNumber(model.totalQpm)}`);
  }
  for (const balance of snapshot.balances ?? []) {
    lines.push("", `Currency: ${sanitize(balance.currency)}`, `Remaining: ${formatCurrencyAmount(balance.currency, balance.remaining)}`,
      ...(balance.toppedUp === undefined ? [] : [`Topped up: ${formatCurrencyAmount(balance.currency, balance.toppedUp)}`]),
      ...(balance.granted === undefined ? [] : [`Granted: ${formatCurrencyAmount(balance.currency, balance.granted)}`]));
  }
  for (const window of windows) {
    lines.push(
      "",
      `${detailWindowLabel(window)} quota`,
      `Remaining: ${formatPercent(window.remainingPercent)}`,
      `Used: ${formatPercent(window.usedPercent)}`,
      ...resetDetails(window.resetsAt, now),
    );
  }
  return { title: `${providerName} capacity`, body: lines.join("\n") };
}

function windowRank(kind: CapacityWindowKind): number {
  const rank: Record<CapacityWindowKind, number> = {
    five_hour: 0,
    seven_day: 1,
    weekly: 2,
    other: 3,
  };
  return rank[kind];
}

function accountWindows(windows: readonly CapacityWindow[] | undefined): CapacityWindow[] {
  if (!windows) return [];
  return windows
    .slice()
    .sort((left, right) => windowRank(left.kind) - windowRank(right.kind));
}

function detailWindows(windows: readonly CapacityWindow[] | undefined): CapacityWindow[] {
  return (windows ?? []).slice().sort((left, right) =>
    windowRank(left.kind) - windowRank(right.kind) || (left.label ?? "").localeCompare(right.label ?? ""));
}

function detailWindowLabel(window: CapacityWindow): string {
  if (window.label === "Shared") return "Shared";
  const scope = window.label ? `${sanitize(window.label)} · ` : "";
  return `${scope}${windowLabel(window)}`;
}

function statuslineResetQuota(remainingPercent: number, resetsAt: number, now: number): string {
  return `${formatPercent(remainingPercent)} · ${formatStatuslineRemaining(resetsAt * 1_000 - now)}`;
}

function statuslineResetQuotaColored(
  theme: CapacityTheme,
  remainingPercent: number,
  resetsAt: number,
  now: number,
): string {
  const quota = colorQuota(theme, formatPercent(remainingPercent), remainingPercent);
  const reset = theme.fg("dim", ` · ${formatStatuslineRemaining(resetsAt * 1_000 - now)}`);
  return `${quota}${reset}`;
}

function formatStatuslineRemaining(milliseconds: number): string {
  let minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(minutes / 1_440);
  minutes -= days * 1_440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  return `${minutes}m`;
}

function resetDetails(resetsAt: number | undefined, now: number): string[] {
  if (resetsAt === undefined) return ["Resets at: not reported", "Time remaining: not reported"];
  const resetMs = resetsAt * 1_000;
  return [
    `Resets at: ${formatExactTime(resetMs)}`,
    `Time remaining: ${formatDetailedRemaining(resetMs - now)}`,
  ];
}

function formatExactTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace("T", " ").replace("Z", " UTC");
}

function formatDetailedRemaining(milliseconds: number): string {
  if (milliseconds <= 0) return "now";
  let seconds = Math.ceil(milliseconds / 1_000);
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length < 2 && seconds > 0) parts.push(`${seconds}s`);
  return parts.slice(0, 3).join(" ");
}

function summaryWindowLabel(window: CapacityWindow): string {
  return window.label === undefined ? windowLabel(window) : sanitize(window.label);
}

function statuslineWindowLabel(window: CapacityWindow): string {
  return window.label === "Shared" ? "" : `${summaryWindowLabel(window)} `;
}

function windowLabel(window: CapacityWindow): string {
  if (window.kind === "five_hour") return "5h";
  if (window.kind === "seven_day") return "7d";
  if (window.kind === "weekly") return "Weekly";
  if (window.windowSeconds && window.windowSeconds > 0) return formatDuration(window.windowSeconds);
  return "Limit";
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return "Limit";
}

function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function formatPercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  return `${Number.isInteger(clamped) ? clamped : clamped.toFixed(1)}%`;
}

function formatLoadPercent(value: number): string {
  const load = Math.max(0, value);
  return `${Number.isInteger(load) ? load : load.toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function validRefreshReceipt(value: unknown): boolean {
  return isRecord(value)
    && isCapacityProviderId(value.provider)
    && typeof value.refreshed === "boolean"
    && STATES.has(value.state as CapacityState)
    && (value.observedAt === undefined || finite(value.observedAt) && value.observedAt >= 0)
    && (value.error === undefined || typeof value.error === "string");
}

function validProvider(value: unknown): boolean {
  if (!isRecord(value) || !isCapacityProviderId(value.provider) || !STATES.has(value.state as CapacityState)) {
    return false;
  }
  if (value.observedAt !== undefined && !finite(value.observedAt)) return false;
  if (value.staleAfter !== undefined && !finite(value.staleAfter)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.plan !== undefined && typeof value.plan !== "string") return false;
  if (value.windows !== undefined && (!Array.isArray(value.windows) || !value.windows.every(validWindow))) return false;
  if (value.gateway !== undefined && !validGateway(value.gateway)) return false;
  if (value.models !== undefined && !validModels(value.models)) return false;
  if (value.balances !== undefined && !validBalances(value.balances)) return false;
  return true;
}

function validWindow(value: unknown): boolean {
  return isRecord(value)
    && WINDOW_KINDS.has(value.kind as CapacityWindowKind)
    && finite(value.usedPercent)
    && finite(value.remainingPercent)
    && (value.windowSeconds === undefined || finite(value.windowSeconds))
    && (value.resetsAt === undefined || finite(value.resetsAt))
    && (value.label === undefined || typeof value.label === "string");
}

function validGateway(value: unknown): boolean {
  return isRecord(value)
    && finite(value.active)
    && finite(value.queued)
    && finite(value.backgroundActive)
    && (value.maxActive === undefined || finite(value.maxActive));
}

function validModels(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((model) => {
    if (!isRecord(model)
      || model.observedAt !== undefined && !finite(model.observedAt)
      || !["loadPercent", "queueSize", "outputQpm", "totalQpm"].every((key) =>
        model[key] === undefined || finite(model[key]))) return false;
    return model.quota === undefined || validModelQuota(model.quota);
  });
}

function validModelQuota(value: unknown): boolean {
  return isRecord(value)
    && finite(value.remaining)
    && finite(value.limit)
    && value.limit > 0
    && value.remaining >= 0
    && value.remaining <= value.limit
    && (value.observedAt === undefined || finite(value.observedAt))
    && (value.used === undefined || finite(value.used) && value.used >= 0 && value.used <= value.limit)
    && (value.resetsAt === undefined || finite(value.resetsAt) && value.resetsAt > 0);
}

function validBalances(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(validBalance);
}

function validBalance(value: unknown): boolean {
  return isRecord(value)
    && typeof value.currency === "string"
    && value.currency.trim().length > 0
    && finite(value.remaining)
    && value.remaining >= 0
    && (value.granted === undefined || finite(value.granted) && value.granted >= 0)
    && (value.toppedUp === undefined || finite(value.toppedUp) && value.toppedUp >= 0);
}

function providerLabel(provider: CapacityProviderId): string {
  return sanitize(provider);
}

function formatCurrencyAmount(currency: string, amount: number): string {
  const value = amount.toFixed(2);
  if (currency === "CNY") return `¥${value}`;
  if (currency === "USD") return `$${value}`;
  return `${sanitize(currency)} ${value}`;
}

function colorBalance(theme: CapacityTheme, text: string, remaining: number): string {
  return theme.fg(remaining <= 0 ? "error" : "success", text);
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
