interface EditorSegmentHost {
  segment?: unknown;
}

export interface EditorImageSegmentContract {
  install(validIds: () => ReadonlySet<number>): () => void;
}

interface SegmentDataLike {
  segment: string;
  index: number;
  input: string;
  isWordLike?: boolean;
}

const IMAGE_MARKER_RE = /\[Image #(\d+)\]/gu;

function mergeImageMarkers(
  text: string,
  segments: readonly SegmentDataLike[],
  validIds: ReadonlySet<number>,
): SegmentDataLike[] {
  if (validIds.size === 0 || !text.includes("[Image #")) return [...segments];
  const markers = [...text.matchAll(IMAGE_MARKER_RE)]
    .filter((match) => validIds.has(Number(match[1])))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
  if (markers.length === 0) return [...segments];

  const result: SegmentDataLike[] = [];
  let markerIndex = 0;
  for (const segment of segments) {
    while (markerIndex < markers.length && markers[markerIndex]!.end <= segment.index) markerIndex++;
    const marker = markers[markerIndex];
    if (!marker || segment.index < marker.start || segment.index >= marker.end) {
      result.push(segment);
      continue;
    }
    if (segment.index === marker.start) {
      result.push({ segment: text.slice(marker.start, marker.end), index: marker.start, input: text });
    }
  }
  return result;
}

/**
 * Pi 1.2 routes cursor movement, deletion, word navigation and word-wrap
 * through Editor.segment(). Merge only live `[Image #n]` placeholders into
 * atomic segments and leave every editing operation owned by Pi. Missing or
 * changed segment contracts fail closed to ordinary text.
 */
export function editorImageSegmentContract(instance: unknown): EditorImageSegmentContract | undefined {
  const host = instance as EditorSegmentHost;
  if (typeof host.segment !== "function") return undefined;
  const original = host.segment as (text: string, mode: unknown) => Iterable<SegmentDataLike>;
  return {
    install(validIds) {
      const patched = function imageAwareSegment(text: string, mode: unknown): Iterable<SegmentDataLike> {
        return mergeImageMarkers(text, [...original.call(host, text, mode)], validIds());
      };
      host.segment = patched;
      return () => {
        if (host.segment === patched) host.segment = original;
      };
    },
  };
}

export function hasAtomicImageSegmentContract(instance: unknown): boolean {
  const contract = editorImageSegmentContract(instance);
  if (!contract) return false;
  const release = contract.install(() => new Set([1]));
  try {
    const host = instance as EditorSegmentHost;
    const segments = [...(host.segment as (text: string, mode: string) => Iterable<SegmentDataLike>)(
      "[Image #1]",
      "grapheme",
    )];
    return segments.length === 1 && segments[0]?.segment === "[Image #1]";
  } catch {
    return false;
  } finally {
    release();
  }
}
