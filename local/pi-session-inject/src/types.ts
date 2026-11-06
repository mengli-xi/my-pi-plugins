/**
 * Idle-append boundary and live message port interfaces.
 *
 * These are the Pi-aware seams a caller supplies to `appendAtSafeBoundary`.
 * They mirror the shapes pi-subagents uses internally, so the same Pi runtime
 * identity (SessionManager, pi.sendMessage) drives both paths without coupling
 * this library to any particular package.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * The idle/authority boundary a live Pi exposes for safe appending. A custom
 * message that triggers a turn may only be appended once the model is idle and
 * no unresolved tool calls remain; otherwise the entry can land inside an
 * active tool batch and break tool-call/result ordering.
 */
export interface IdleAppendBoundary {
  /** Wait until the model is idle. Resolve immediately if already idle. */
  waitForIdle(): Promise<void>;
  /** Is the model idle right now? */
  isIdle(): boolean;
  /** Does this boundary still own the live session (not replaced/reloaded)? */
  isCurrent(): boolean;
}

/**
 * A thin wrapper over `pi.sendMessage` so this library does not import the Pi
 * SDK directly. `deliverAs:"steer"` places the message into the current turn
 * without waking a new one; `triggerTurn` requests a model run.
 */
export interface LiveMessagePort {
  send(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { triggerTurn: boolean; deliverAs?: "steer" | "nextTurn" },
  ): void;
}

/** Minimal SessionManager shape this library needs (getBranch entries). */
export type { SessionManager };
