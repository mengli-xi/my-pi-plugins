/**
 * Everything about fast mode that can be decided without a running pi:
 * whether a provider payload should carry `service_tier: "priority"`, and
 * how the toggle persists across sessions.
 *
 * The injection is payload-level on purpose. pi-ai's codex adapter does
 * accept a `serviceTier` stream option, but extensions have no seam to set
 * per-request stream options — the seam they do have is
 * `before_provider_request`, which hands over the exact JSON body about to
 * be sent (before both the SSE and WebSocket transports, which share one
 * body). Setting `service_tier` there is equivalent.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** The only provider whose backend is known to accept the tier. */
export const CODEX_PROVIDER = "openai-codex";

/** Priority tier requested from the Codex provider. */
export const FAST_TIER = "priority";

/**
 * Branch-local state persisted in the session JSONL. `null` is an explicit
 * "follow the global default" marker, needed so `/fast all` can supersede an
 * older per-session override on the same branch.
 */
export const SESSION_STATE_ENTRY_TYPE = "pi-fast:session-state-v1";

export interface FastSessionStateEntry {
  enabled: boolean | null;
}

/**
 * Reconstruct the effective per-session override from the active branch.
 * Rewinding before a state entry naturally removes it from this scan.
 */
export function restoreSessionOverride(
  entries: readonly SessionEntry[],
): boolean | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const enabled = (data as { enabled?: unknown }).enabled;
    if (enabled === true || enabled === false) return enabled;
    if (enabled === null) return undefined;
  }
  return undefined;
}

/**
 * Return a replacement payload carrying the fast tier, or undefined when the
 * request should go out untouched (which `before_provider_request` treats as
 * "keep the original").
 *
 * Untouched when: fast mode is off, the model is not served by the codex
 * provider, the payload is not a plain request body, or the body already
 * names a tier (a user override in models.json outranks the toggle).
 */
export function applyFastTier(
  payload: unknown,
  providerId: string | undefined,
  enabled: boolean,
): Record<string, unknown> | undefined {
  if (!enabled || providerId !== CODEX_PROVIDER) return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (typeof body.model !== "string") return undefined;
  if (body.service_tier !== undefined) return undefined;
  return { ...body, service_tier: FAST_TIER };
}

/** Where the toggle lives so it survives a restart. */
export function defaultStatePath(): string {
  return join(getAgentDir(), "pi-fast.json");
}

export function loadEnabled(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { enabled?: unknown }).enabled === true
    );
  } catch {
    return false;
  }
}

export function saveEnabled(path: string, enabled: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}
