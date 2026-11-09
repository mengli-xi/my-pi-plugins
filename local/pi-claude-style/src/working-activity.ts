/**
 * The model's own account of what it is doing right now, for the working row.
 *
 * Codex-family models stream reasoning *summaries* whose sections open with a
 * bold headline — `**Explaining quicksort average complexity**` — a running
 * description of the current activity. pi-ai delivers them as thinking deltas;
 * this tracker watches the stream and keeps the newest complete headline.
 *
 * Anthropic-style free-text thinking has no such structure, so the tracker
 * simply never produces a headline there and the working row keeps its
 * rotating verb. Detection is by shape, not by provider: whoever streams
 * bold-headline summaries gets the label.
 */

/** The subset of assistant stream events the tracker cares about. */
export interface ActivityStreamEvent {
  type: string;
  delta?: string;
}

// Codex summary headlines occupy their own Markdown line. Restricting the
// shape here keeps ordinary inline emphasis (`**first** thought`) in the
// thinking body instead of promoting it into the spinner.
const HEADLINE = /^[ \t]*\*\*([^*\n]{1,200}?)\*\*[ \t]*$/gm;
/** Labels longer than this are cut mid-word; the row is one line tall. */
const MAX_LABEL_CHARS = 56;

export interface ActivityHeadlineMatch {
  label: string;
  start: number;
  end: number;
}

/** The newest complete summary headline in one rendered thinking string. */
export function latestActivityHeadline(
  thinking: string,
): ActivityHeadlineMatch | undefined {
  let latest: ActivityHeadlineMatch | undefined;
  for (const match of thinking.matchAll(HEADLINE)) {
    const label = match[1]!.trim();
    if (!label || match.index === undefined) continue;
    latest = {
      label,
      start: match.index,
      end: match.index + match[0].length,
    };
  }
  return latest;
}

/**
 * Removes the headline line that the working spinner renders separately.
 * The source assistant message is never changed; callers use this only for
 * the live presentation clone.
 */
export function stripLatestActivityHeadline(thinking: string): {
  thinking: string;
  headline?: ActivityHeadlineMatch;
} {
  const headline = latestActivityHeadline(thinking);
  if (!headline) return { thinking };

  const lineStart = thinking.lastIndexOf("\n", headline.start - 1) + 1;
  const nextLineBreak = thinking.indexOf("\n", headline.end);
  const lineEnd = nextLineBreak < 0 ? thinking.length : nextLineBreak;
  const occupiesLine =
    thinking.slice(lineStart, headline.start).trim().length === 0 &&
    thinking.slice(headline.end, lineEnd).trim().length === 0;

  if (!occupiesLine) {
    return {
      thinking: `${thinking.slice(0, headline.start)}${thinking.slice(headline.end)}`,
      headline,
    };
  }

  const before = thinking.slice(0, lineStart).trimEnd();
  const afterStart = nextLineBreak < 0 ? lineEnd : nextLineBreak + 1;
  const after = thinking.slice(afterStart).trimStart();
  return {
    thinking: before && after ? `${before}\n\n${after}` : before || after,
    headline,
  };
}

export class ActivityTracker {
  private buffer = "";
  private headline: string | undefined;

  /** Feed one stream event. Returns true when the headline changed. */
  handle(event: ActivityStreamEvent): boolean {
    if (event.type === "thinking_start") {
      // A new thinking block starts a new summary; earlier text no longer
      // describes the present. The last headline stays until replaced.
      this.buffer = "";
      return false;
    }
    if (event.type !== "thinking_delta" || !event.delta) return false;
    this.buffer += event.delta;

    const latest = latestActivityHeadline(this.buffer);
    if (!latest) return false;
    const headline = truncate(latest.label);
    if (headline === this.headline) return false;
    this.headline = headline;
    return true;
  }

  current(): string | undefined {
    return this.headline;
  }

  /** A new run starts blank — yesterday's activity is not today's. */
  reset(): void {
    this.buffer = "";
    this.headline = undefined;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_LABEL_CHARS) return text;
  return `${text.slice(0, MAX_LABEL_CHARS - 1)}…`;
}
