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
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

/**
 * Replace the default atomically: a reader never observes a half-written file,
 * and a failed write keeps the previous default intact (`loadEnabled` is called
 * on every request). The temporary file lives in the same directory so the
 * rename stays on one filesystem.
 */
export function saveEnabled(path: string, enabled: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was never created.
    }
    throw error;
  }
}
