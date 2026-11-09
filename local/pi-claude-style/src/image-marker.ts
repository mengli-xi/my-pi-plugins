import type { MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";

const IMAGE_MARKER_RE = /\[Image #(\d+)\]/g;
const PI_CLIPBOARD_IMAGE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)(?:[^\s/\\]+[\\/])*pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|gif|webp|bmp)/gi;
const PI_CLIPBOARD_IMAGE_BASENAME_RE = /(?:^|[/\\])pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|gif|webp|bmp)$/i;

export function isPiClipboardImagePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === value && PI_CLIPBOARD_IMAGE_BASENAME_RE.test(trimmed);
}

export function replaceClipboardImagePaths(
  text: string,
  decorate: (marker: string, path: string) => string = (marker) => marker,
): string {
  let nextId = 0;
  return text.replace(
    PI_CLIPBOARD_IMAGE_PATH_RE,
    (path) => decorate(`[Image #${++nextId}]`, path),
  );
}

export const clipboardImageMarkdownTransformer: MarkdownTransformer = (markdown, context) =>
  context.messageType === "user"
    ? replaceClipboardImagePaths(markdown, (marker) => `\`${marker}\``)
    : markdown;

export function paintImageMarkers(lines: readonly string[], theme: Theme): string[] {
  return lines.map((line) => line.replace(IMAGE_MARKER_RE, (marker) => theme.fg("accent", marker)));
}
