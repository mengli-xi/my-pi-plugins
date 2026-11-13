/**
 * Hide Markdown code-fence marker rows (```lang / ```) in the places CC owns:
 * assistant prose, CC's thinking rows and CC's Thinking/Activity panels. The
 * code body stays; other Markdown in the process keeps Pi's native rendering.
 */
import type { Component } from "@earendil-works/pi-tui";

const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function isCodeFenceMarkerLine(line: string): boolean {
  if (!line.includes("`")) return false;
  const plain = line.replace(ANSI_OSC_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
  return /^\s*```[^`]*\s*$/u.test(plain);
}

export function withoutCodeFenceMarkers(lines: readonly string[]): string[] {
  return lines.filter((line) => !isCodeFenceMarkerLine(line));
}

export interface CodeFenceFrames {
  frames?: WeakMap<Component, { width: number; native: string[]; lines: string[] }>;
}

/** Drops rendered Markdown fence marker rows while keeping code body lines. */
export class CodeFenceMarkerHidingComponent implements Component {
  private readonly child: Component;
  private readonly owner: CodeFenceFrames;

  constructor(child: Component, owner: CodeFenceFrames = { frames: new WeakMap() }) {
    this.child = child;
    this.owner = owner;
  }

  render(width: number): string[] {
    // Always read the child: native Markdown owns text, Thinking and wrapping.
    const native = this.child.render(width);
    const cached = this.owner.frames?.get(this);
    if (cached && cached.width === width && native.length === cached.native.length &&
      native.every((line, index) => line === cached.native[index])) return cached.lines.slice();
    const lines = withoutCodeFenceMarkers(native);
    this.owner.frames?.set(this, { width, native: native.slice(), lines });
    return lines.slice();
  }

  invalidate(): void {
    this.owner.frames?.delete(this);
    this.child.invalidate?.();
  }

  dispose(): void {
    this.owner.frames?.delete(this);
  }
}
