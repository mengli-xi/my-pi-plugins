import type { MailboxErrorCode } from "./types.js";
/** Structural across separately compiled consumers; never infer retryability
 * from an error message or treat arbitrary proof/IO failures as contention. */
export function isReadRace(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "read-race";
}
export class MailboxError extends Error {
  readonly code: MailboxErrorCode;
  constructor(code: MailboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailboxError";
    this.code = code;
  }
}
