import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_SPINNER_GLYPHS,
  buildClaudeSpinnerFrames,
  buildThemedPulseFrames,
  claudeIndicatorPalette,
  paintClaudeShimmer,
  fitCyberSegments,
  joinCyber,
  paintLetterWave,
  paintMutedShimmer,
  paintThemedLetterWave,
  segment,
} from "../src/cyber-style.ts";
import { StreamingTokenEstimator } from "../src/token-usage.ts";

test("provides theme-aware cyber pulse and deterministic letter wave", () => {
  const frames = buildThemedPulseFrames({
    fg: (color, text) => `<${color}>${text}</${color}>`,
  });
  assert.equal(frames.length, 24);
  assert.match(frames[0]!, /<dim>/);
  assert.match(frames[4]!, /<muted>/);
  assert.match(frames[8]!, /<accent>/);
  assert.notEqual(frames[0], frames[12]);
  const renderedGlyphs = new Set(
    frames.map((frame) => frame.replace(/<\/?[^>]+>/g, "")),
  );
  assert.deepEqual(
    [...renderedGlyphs].sort(),
    [...CLAUDE_SPINNER_GLYPHS].sort(),
  );
  assert.ok(!renderedGlyphs.has("●"));
  assert.equal(paintLetterWave("Flow", 1_000), paintLetterWave("Flow", 1_000));
  const themedWave = paintThemedLetterWave(
    "Flow",
    { fg: (color, text) => `<${color}>${text}</${color}>` },
    1_000,
  );
  assert.match(themedWave, /<(?:accent|text|muted)>/);
  assert.equal(
    themedWave,
    paintThemedLetterWave(
      "Flow",
      { fg: (color, text) => `<${color}>${text}</${color}>` },
      1_000,
    ),
  );
});

test("sweeps a neutral highlight over a muted tool label", () => {
  const used: string[] = [];
  const rendered = paintMutedShimmer(
    "Running tools",
    {
      fg: (color: string, text: string) => {
        used.push(color);
        return text;
      },
    } as any,
    1_000,
  );

  assert.equal(rendered, "Running tools");
  assert.deepEqual([...new Set(used)].sort(), ["muted", "text"]);
});

test("sweeps a three-character highlight over a terracotta base", () => {
  const stripAnsi = (text: string) =>
    text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const label = "Pondering";
  // Step 10 puts the sweep centre on index 0, so characters 0 and 1 are lit
  // and everything after them sits in the base colour.
  const atStart = paintClaudeShimmer(label, 10 * 100);
  assert.equal(stripAnsi(atStart), label);
  assert.ok(atStart.startsWith(claudeIndicatorPalette.shimmer));
  assert.ok(atStart.endsWith("\x1b[39m"));

  const lit = (rendered: string) => {
    const characters: string[] = [];
    let colour: string | undefined;
    for (const part of rendered.split(/(\x1b\[[0-9;]*m)/)) {
      if (part.startsWith("\x1b")) colour = part;
      else if (colour === claudeIndicatorPalette.shimmer) {
        characters.push(...part);
      }
    }
    return characters.join("");
  };
  assert.equal(lit(atStart), "Po");
  // Two steps later the centre has moved to index 2, lighting 1..3.
  assert.equal(lit(paintClaudeShimmer(label, 12 * 100)), "ond");

  // Off-string steps leave the whole label in the base colour.
  const dark = paintClaudeShimmer(label, 0);
  assert.equal(lit(dark), "");
  assert.ok(dark.startsWith(claudeIndicatorPalette.base));

  // Same clock in, same string out — the row must not jitter between repaints.
  assert.equal(
    paintClaudeShimmer(label, 1_000),
    paintClaudeShimmer(label, 1_000),
  );
  assert.equal(paintClaudeShimmer("", 1_000), "");
});

test("builds spinner frames from the extension's own terracotta stops", () => {
  const frames = buildClaudeSpinnerFrames();
  assert.equal(frames.length, 24);
  const used = new Set(
    frames.map((frame) => frame.slice(0, frame.indexOf("m") + 1)),
  );
  assert.deepEqual(
    [...used].sort(),
    [
      claudeIndicatorPalette.base,
      claudeIndicatorPalette.shimmer,
      claudeIndicatorPalette.trough,
    ].sort(),
  );
  // No theme lookups: identical output on every call, whatever the theme is.
  assert.deepEqual(frames, buildClaudeSpinnerFrames());
  const glyphs = new Set(
    frames.map((frame) => frame.replace(/\x1b\[[0-9;]*m/g, "")),
  );
  assert.deepEqual([...glyphs].sort(), [...CLAUDE_SPINNER_GLYPHS].sort());
});

test("drops low-priority segments first", () => {
  const fitted = fitCyberSegments(
    [
      segment("Working...", 100),
      segment("10s", 95),
      segment("tokens", 70),
      segment("esc to cancel", 20),
    ],
    24,
  );
  assert.match(fitted, /Working/);
  assert.doesNotMatch(fitted, /esc to cancel/);
});

test("keeps compact separators and parenthesis spacing", () => {
  const stripAnsi = (text: string) =>
    text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal(stripAnsi(joinCyber(["a", "b"])), "a · b");
  assert.equal(
    stripAnsi(fitCyberSegments([segment("Working...", 100), segment("1s", 95)], 40)),
    "Working... (1s)",
  );
});

test("uses reserved widths so live value growth does not toggle segments", () => {
  const short = segment("↑1 ↓1", 90, 14);
  const longer = segment("↑375 ↓279", 90, 14);
  assert.equal(short.budgetWidth, 14);
  assert.equal(longer.budgetWidth, 14);
});

test("estimates numeric and CJK output using cyber token buckets", () => {
  const estimator = new StreamingTokenEstimator();
  estimator.add("12345678");
  assert.equal(estimator.value(), 3);
  estimator.reset();
  estimator.add("你好世界");
  assert.equal(estimator.value(), 4);
});
