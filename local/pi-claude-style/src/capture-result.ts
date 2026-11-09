import { truncateText } from "./format.ts";
import { resultImages } from "./image-preview.ts";
import type { CapturedResult } from "./types.ts";

function getTextContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const candidate = block as Record<string, unknown>;
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return candidate.text;
      }
      if (candidate.type === "image") {
        const mime =
          typeof candidate.mimeType === "string"
            ? ` ${candidate.mimeType}`
            : "";
        return `[image${mime}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function captureResult(
  result: unknown,
  isError: boolean,
  maxChars: number,
): CapturedResult {
  const record =
    typeof result === "object" && result !== null
      ? result as Record<string, unknown>
      : {};
  let rawText = getTextContent(record.content);
  // Only the count and size: the payload stays in Pi's result, which the
  // transcript row and its preview read directly.
  const images = resultImages(record.content);
  if (!rawText) {
    if (typeof result === "string") {
      rawText = result;
    } else {
      try {
        rawText = JSON.stringify(result ?? "");
      } catch {
        rawText = String(result);
      }
    }
  }
  const truncated = truncateText(rawText, maxChars);
  const rawDetails = record.details;
  let details: CapturedResult["details"];
  let detailsTruncated = false;
  if (rawDetails !== undefined) {
    try {
      const serialized = JSON.stringify(rawDetails);
      if (serialized.length <= maxChars) {
        details = JSON.parse(serialized) as unknown;
      } else {
        detailsTruncated = true;
      }
    } catch {
      detailsTruncated = true;
    }
  }
  if (
    details === undefined &&
    typeof rawDetails === "object" &&
    rawDetails !== null &&
    typeof (rawDetails as Record<string, unknown>).diff === "string"
  ) {
    const detailRecord = rawDetails as Record<string, unknown>;
    const capturedDiff = truncateText(detailRecord.diff as string, maxChars);
    detailsTruncated = detailsTruncated || capturedDiff.truncated;
    details = {
      diff: capturedDiff.text,
      firstChangedLine: detailRecord.firstChangedLine,
    };
  }
  return {
    text: truncated.text,
    truncated: truncated.truncated || detailsTruncated,
    isError,
    details,
    imageSummary: images.length > 0
      ? {
        count: images.length,
        totalBytes: images.reduce((total, image) => total + image.sizeBytes, 0),
      }
      : undefined,
  };
}
