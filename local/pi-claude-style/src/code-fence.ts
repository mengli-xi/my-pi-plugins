/**
 * Hide Markdown code-fence marker rows (```lang / ```) in the places CC owns:
 * assistant prose, CC's thinking rows and CC's Thinking/Activity panels. The
 * code body stays; other Markdown in the process keeps Pi's native rendering.
 */
import type { Component } from "@earendil-works/pi-tui";

const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function isCodeFenceMarkerLine(line: string): boolean {
  const plain = line.replace(ANSI_OSC_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
  return /^\s*```[^`]*\s*$/u.test(plain);
}

export function withoutCodeFenceMarkers(lines: readonly string[]): string[] {
  return lines.filter((line) => !isCodeFenceMarkerLine(line));
}

/** Drops rendered Markdown fence marker rows while keeping code body lines. */
export class CodeFenceMarkerHidingComponent implements Component {
  private readonly child: Component;

  constructor(child: Component) {
    this.child = child;
  }

  render(width: number): string[] {
    return withoutCodeFenceMarkers(this.child.render(width));
  }

  invalidate(): void {
    this.child.invalidate?.();
  }
}
