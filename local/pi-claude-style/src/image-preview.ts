export interface ToolImagePreview {
  data: string;
  mimeType: string;
  sizeBytes: number;
  path?: string;
}

export interface ToolImageSummary {
  count: number;
  totalBytes: number;
}

export function isImageReadToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "read" || normalized === "read_file";
}

export function decodedBase64Bytes(data: string): number {
  const compact = data.replace(/\s+/g, "");
  if (!compact) return 0;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

/** The image blocks of a tool result, with their decoded size. */
export function resultImages(content: unknown): ToolImagePreview[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const candidate = block as Record<string, unknown>;
    if (
      candidate.type !== "image" ||
      typeof candidate.data !== "string" ||
      !candidate.data ||
      typeof candidate.mimeType !== "string" ||
      !candidate.mimeType
    ) return [];
    return [{
      data: candidate.data,
      mimeType: candidate.mimeType,
      sizeBytes: decodedBase64Bytes(candidate.data),
    }];
  });
}

/**
 * The images a tool result carried, as the preview opens them. Only a read's
 * `path` names the image itself; other tools' path arguments are inputs, so
 * the panel would offer to open the wrong file.
 */
export function toolResultImagePreviews(
  toolName: string,
  args: unknown,
  content: unknown,
): ToolImagePreview[] {
  const images = resultImages(content);
  const path = isImageReadToolName(toolName) ? imagePath(args) : undefined;
  return path ? images.map((image) => ({ ...image, path })) : images;
}

function imagePath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const value = record.path ?? record.file_path ?? record.filePath;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function formatImageBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${trimDecimal(safe / 1024)} KB`;
  return `${trimDecimal(safe / (1024 * 1024))} MB`;
}

function trimDecimal(value: number): string {
  const digits = value >= 100 ? 0 : 1;
  return value.toFixed(digits).replace(/\.0$/, "");
}

export function imageActionLabel(summary: ToolImageSummary): string {
  const size = formatImageBytes(summary.totalBytes);
  return summary.count === 1
    ? `View Image (${size})`
    : `View ${summary.count} Images (${size})`;
}

export function imagePanelHeading(images: readonly ToolImagePreview[]): string {
  return images.length === 1 ? "Image" : `${images.length} Images`;
}
