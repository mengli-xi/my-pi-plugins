import type { MailboxErrorCode } from "./types.js";
export class MailboxError extends Error {
  readonly code: MailboxErrorCode;
  constructor(code: MailboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailboxError";
    this.code = code;
  }
}
