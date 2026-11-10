export type ConfirmationPress = "armed" | "confirmed";

export const DESTROY_CONFIRMATION_WINDOW_MS = 4_000;

export class DestroyConfirmation {
  private readonly windowMs: number;
  private deadlineMs = 0;

  constructor(windowMs = DESTROY_CONFIRMATION_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  press(nowMs = Date.now()): ConfirmationPress {
    if (this.isActive(nowMs)) {
      this.deadlineMs = 0;
      return "confirmed";
    }
    this.deadlineMs = nowMs + this.windowMs;
    return "armed";
  }

  cancel(): void {
    this.deadlineMs = 0;
  }

  isActive(nowMs = Date.now()): boolean {
    if (this.deadlineMs <= nowMs) {
      this.deadlineMs = 0;
      return false;
    }
    return true;
  }
}
