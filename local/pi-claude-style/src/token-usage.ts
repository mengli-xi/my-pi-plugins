interface TokenBuckets {
  punctuation: number;
  digit: number;
  latin: number;
  cjk: number;
  cyrillic: number;
  other: number;
}

export function supportsExactStreamingUsage(api?: string): boolean {
  return api === "anthropic-messages";
}

function emptyBuckets(): TokenBuckets {
  return {
    punctuation: 0,
    digit: 0,
    latin: 0,
    cjk: 0,
    cyrillic: 0,
    other: 0,
  };
}

function classify(codePoint: number): keyof TokenBuckets | undefined {
  if (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    codePoint === 0x20
  ) {
    return undefined;
  }
  if (codePoint >= 0x30 && codePoint <= 0x39) return "digit";
  if (
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  ) {
    return "latin";
  }
  if (codePoint < 0x80) return "punctuation";
  if (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  ) {
    return "cjk";
  }
  if (codePoint >= 0x0400 && codePoint <= 0x04ff) return "cyrillic";
  return "other";
}

function estimate(buckets: TokenBuckets): number {
  return (
    buckets.punctuation +
    Math.ceil(buckets.digit / 3) +
    Math.ceil(buckets.latin / 4.5) +
    buckets.cjk +
    Math.ceil(buckets.cyrillic / 3.3) +
    Math.ceil(buckets.other / 2.5)
  );
}

/** Lightweight BPE-inspired estimator copied from cyber-ui's HUD accounting. */
export class StreamingTokenEstimator {
  private buckets = emptyBuckets();

  reset(): void {
    this.buckets = emptyBuckets();
  }

  add(text: string): void {
    for (const character of text) {
      const bucket = classify(character.codePointAt(0) ?? 0);
      if (bucket) this.buckets[bucket]++;
    }
  }

  value(): number {
    return estimate(this.buckets);
  }
}
