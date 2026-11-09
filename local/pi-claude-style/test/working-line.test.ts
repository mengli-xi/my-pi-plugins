import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_WORKING } from "../src/config.ts";
import {
  claudeIndicatorPalette,
  RESET_FG,
  workingStatusPalette,
} from "../src/cyber-style.ts";
import { formatTokenCount, formatTps } from "../src/format.ts";
import type { RunMetricsSnapshot, WorkingConfig } from "../src/types.ts";
import {
  buildCyberWorkingLine,
  cyberTokenSegment,
  cyberTps,
  WorkingLineSlots,
} from "../src/working-line.ts";
import { buildCyberDoneLine } from "../src/working.ts";

/** Renders without ANSI so column positions are directly assertable. */
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

function snapshot(
  partial: Partial<RunMetricsSnapshot>,
): RunMetricsSnapshot {
  return {
    status: "running",
    phase: "generating",
    elapsedMs: 0,
    outputEstimated: false,
    tpsEstimated: false,
    turnCount: 0,
    ...partial,
  };
}

const config: WorkingConfig = { ...DEFAULT_WORKING, messageWidth: 200 };

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Column of every separator, which is what the eye tracks for jitter. */
function separatorColumns(line: string): number[] {
  line = plain(line);
  const columns: number[] = [];
  let index = line.indexOf(" · ");
  while (index >= 0) {
    columns.push(index);
    index = line.indexOf(" · ", index + 1);
  }
  return columns;
}

test("picks one rendering per magnitude", () => {
  assert.equal(formatTokenCount(9_949), "9.9k");
  assert.equal(formatTokenCount(9_999), "9.9k");
  assert.equal(formatTokenCount(10_000), "10.0k");
  assert.equal(formatTokenCount(21_400), "21.4k");
  assert.equal(formatTokenCount(21_499), "21.4k");
  assert.equal(formatTokenCount(99_999), "99.9k");
  assert.equal(formatTokenCount(100_000), "100k");
  assert.equal(formatTokenCount(999_999), "999k");
  assert.equal(formatTokenCount(1_000_000), "1.0M");
  assert.equal(formatTokenCount(1_099_999), "1.0M");
  assert.equal(formatTps(99.94), "99.9t/s");
  assert.equal(formatTps(99.95), "100t/s");
});

test("does not preserve a long headline as invisible prefix padding", () => {
  const slots = new WorkingLineSlots();
  const current = snapshot({ elapsedMs: 2_400, inputTokens: 21_400, outputTokens: 42 });
  slots.update(current);

  buildCyberWorkingLine(
    "Explaining a deliberately long implementation headline",
    current,
    slots,
    config,
    plainTheme,
  );
  const short = buildCyberWorkingLine(
    "Brief",
    current,
    slots,
    config,
    plainTheme,
  ).replace(/\x1b\[[0-9;]*m/g, "");

  assert.match(short, /^Brief\.\.\.\n  2\.4s ·/);
  assert.doesNotMatch(short, /Brief\.\.\.[^\n]+2\.4s/);
});

test("the three headline dots are part of the shimmer sweep", () => {
  const slots = new WorkingLineSlots();
  const current = snapshot({ elapsedMs: 1_000 });
  slots.update(current);
  // "Go..." puts the dots at indices 2..4. At step 13 the three-character
  // shimmer band is centred on index 3, covering all of them.
  const firstLine = buildCyberWorkingLine(
    "Go",
    current,
    slots,
    config,
    plainTheme,
    "",
    config.messageWidth,
    1_300,
  ).split("\n")[0];

  assert.equal(
    firstLine,
    `${claudeIndicatorPalette.base}Go${claudeIndicatorPalette.shimmer}...${RESET_FG}`,
  );
});

test("always renders headline and status on separate bounded rows", () => {
  const slots = new WorkingLineSlots();
  const current = snapshot({ elapsedMs: 2_400, inputTokens: 21_400, outputTokens: 42 });
  slots.update(current);
  const narrow = {
    ...config,
    messageWidth: 16,
    showTps: false,
    showTtft: false,
    showThinkingTime: false,
    showTurns: false,
    showCancelHintAfterMs: 600_000,
  };
  const label = "Explaining the adaptive spinner layout in detail";
  const line = buildCyberWorkingLine(
    label,
    current,
    slots,
    narrow,
    plainTheme,
  ).replace(/\x1b\[[0-9;]*m/g, "");

  const lines = line.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(visibleWidth(lines[0] ?? "") <= narrow.messageWidth);
  assert.ok(visibleWidth(lines[1] ?? "") <= narrow.messageWidth + 2);
  assert.match(lines[0] ?? "", /^Explaining/);
  assert.equal(lines[1], "  2.4s");
});

test("renders each metric as glyph, space, value with no double spaces", () => {
  const slots = new WorkingLineSlots();
  const current = snapshot({
    elapsedMs: 61_000,
    turnCount: 12,
    inputTokens: 128_000,
    outputTokens: 12_400,
    tps: 220,
    ttftMs: 1_800,
    thinkingMs: 4_200,
  });
  slots.update(current);
  const line = buildCyberWorkingLine(
    "Reasoning",
    current,
    slots,
    { ...config, showCancelHintAfterMs: 600_000 },
    plainTheme,
  );
  const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(
    visible,
    "Reasoning...\n  1m01s · ↑ 128k ↓ 12.4k · 220t/s · first 1.8s · thought 4.2s · \u{f0109} 12",
  );
  assert.doesNotMatch(visible, /[()]/);
});

test("status values use independent dark category tones without highlighting", () => {
  const colors: string[] = [];
  const themed = {
    fg: (color: string, text: string) => {
      colors.push(color);
      return `\x1b[38;5;250m${text}\x1b[39m`;
    },
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    italic: (text: string) => text,
  } as unknown as Theme;
  const slots = new WorkingLineSlots();
  const current = snapshot({
    elapsedMs: 61_000,
    turnCount: 12,
    inputTokens: 128_000,
    outputTokens: 12_400,
    tps: 220,
    ttftMs: 1_800,
    thinkingMs: 4_200,
  });
  slots.update(current);
  const status = buildCyberWorkingLine(
    "Reasoning",
    current,
    slots,
    { ...config, showCancelHintAfterMs: 600_000 },
    themed,
  ).split("\n")[1] ?? "";
  const expected = [
    ["elapsed", "1m01s"],
    ["input", "↑ 128k"],
    ["output", "↓ 12.4k"],
    ["tpsFast", "220t/s"],
    ["ttft", "1.8s"],
    ["thinking", "4.2s"],
    ["turns", "12"],
  ] as const;
  for (const [tone, text] of expected) {
    assert.ok(
      status.includes(`${workingStatusPalette[tone]}${text}${RESET_FG}`),
      `${text} uses the ${tone} tone including its unit`,
    );
  }
  assert.equal(status.includes(claudeIndicatorPalette.base), false);
  assert.equal(
    colors.some((color) => ["text", "accent", "success", "warning", "error"].includes(color)),
    false,
  );
  assert.doesNotMatch(status, /\x1b\[1m/);
  assert.match(plain(status), /first 1\.8s/);
  assert.match(plain(status), /thought 4\.2s/);
});

test("cache arrows use the same colour span as their values", () => {
  assert.equal(
    cyberTokenSegment(
      { input: 128_000, output: 12_400, outputEstimated: false },
      config,
      plainTheme,
      true,
    ),
    `${workingStatusPalette.input}↑ 128k${RESET_FG} ${workingStatusPalette.output}↓ 12.4k${RESET_FG}`,
  );

  const dimTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as unknown as Theme;
  assert.equal(
    cyberTokenSegment(
      { input: undefined, output: undefined, outputEstimated: false },
      config,
      dimTheme,
      true,
    ),
    "<dim>↑ –</dim> <dim>↓ –</dim>",
  );
});

test("turn count uses the distinct dark-violet value tone", () => {
  assert.equal(workingStatusPalette.turns, "\x1b[38;5;97m");
});

test("TPS uses dark slow, steady, and fast grades", () => {
  const rendered = (tps: number) => cyberTps(tps, false, plainTheme);
  assert.equal(rendered(19.9), `${workingStatusPalette.tpsSlow}19.9t/s${RESET_FG}`);
  assert.equal(rendered(20), `${workingStatusPalette.tpsSteady}20.0t/s${RESET_FG}`);
  assert.equal(rendered(49.9), `${workingStatusPalette.tpsSteady}49.9t/s${RESET_FG}`);
  assert.equal(rendered(50), `${workingStatusPalette.tpsFast}50.0t/s${RESET_FG}`);
});

test("places provider status before the unchanged spinner metrics", () => {
  const slots = new WorkingLineSlots();
  const current = snapshot({ elapsedMs: 52_800, turnCount: 1 });
  slots.update(current);
  const line = buildCyberWorkingLine(
    "Tejiendo.",
    current,
    slots,
    { ...config, showCancelHintAfterMs: 600_000 },
    plainTheme,
    "[G 4/4 · Queue#2 #7 12.4s]",
  );
  // The label carries the extension's own shimmer colours rather than the
  // theme's, so plainTheme cannot flatten it — compare on the visible text.
  assert.match(
    line.replace(/\x1b\[[0-9;]*m/g, ""),
    /^Tejiendo\.\.\.\n  \[G 4\/4 · Queue#2 #7 12\.4s\] · 52\.8s ·/,
  );
});

test("holds a metric slot once it has been shown", () => {
  const slots = new WorkingLineSlots();
  const withMetrics = snapshot({
    elapsedMs: 3_000,
    turnCount: 1,
    inputTokens: 8_300,
    outputTokens: 450,
    tps: 54.8,
    ttftMs: 1_200,
    thinkingMs: 700,
  });
  slots.update(withMetrics);
  const before = buildCyberWorkingLine(
    "Reasoning",
    withMetrics,
    slots,
    config,
    plainTheme,
  );

  // A later turn restarts partial usage. Cumulative counters and thinking time
  // stay sticky, but a live rate must disappear until the new turn has enough
  // deltas to measure.
  const gap = snapshot({ elapsedMs: 3_200, turnCount: 2 });
  slots.update(gap);
  const after = buildCyberWorkingLine(
    "Reasoning",
    gap,
    slots,
    config,
    plainTheme,
  );

  const visibleAfter = plain(after);
  assert.ok(visibleAfter.includes("↑ 8.3k"));
  assert.ok(!visibleAfter.includes("t/s"));
  assert.ok(visibleAfter.includes("thought 0.7s"));
  assert.notDeepEqual(separatorColumns(after), separatorColumns(before));
});

test("counters never tick backwards mid-run", () => {
  const slots = new WorkingLineSlots();
  slots.update(snapshot({ inputTokens: 12_000, outputTokens: 900 }));
  slots.update(snapshot({ inputTokens: 11_000, outputTokens: 100 }));
  assert.deepEqual(slots.tokens(), {
    input: 12_000,
    output: 900,
    outputEstimated: false,
  });
});

test("keeps the token counters free of an estimate marker", () => {
  const slots = new WorkingLineSlots();
  const estimated = snapshot({
    elapsedMs: 1_000,
    turnCount: 1,
    inputTokens: 5_000,
    outputTokens: 120,
    outputEstimated: true,
  });
  slots.update(estimated);
  const withMarker = buildCyberWorkingLine(
    "Reasoning",
    estimated,
    slots,
    config,
    plainTheme,
  );
  const exact = snapshot({
    elapsedMs: 1_000,
    turnCount: 1,
    inputTokens: 5_000,
    outputTokens: 120,
    outputEstimated: false,
  });
  slots.update(exact);
  const withoutMarker = buildCyberWorkingLine(
    "Reasoning",
    exact,
    slots,
    config,
    plainTheme,
  );
  assert.ok(plain(withMarker).includes("↑ 5.0k ↓ 120"));
  assert.ok(!plain(withMarker).includes("~"));
  assert.equal(withoutMarker, withMarker);
});

test("the late cancel hint does not move the metrics before it", () => {
  const slots = new WorkingLineSlots();
  // Straddle the threshold without crossing a duration digit boundary, so the
  // only thing that can move a column is the hint itself.
  const hintConfig: WorkingConfig = { ...config, showCancelHintAfterMs: 20_000 };
  const render = (elapsedMs: number) => {
    const current = snapshot({
      elapsedMs,
      turnCount: 1,
      inputTokens: 5_000,
      outputTokens: 120,
    });
    slots.update(current);
    return buildCyberWorkingLine(
      "Reasoning",
      current,
      slots,
      hintConfig,
      plainTheme,
    );
  };
  const quiet = render(19_900);
  const hinted = render(20_100);
  assert.ok(!quiet.includes("esc to cancel"));
  assert.ok(hinted.endsWith("esc to cancel"));
  assert.deepEqual(
    separatorColumns(hinted).slice(0, separatorColumns(quiet).length),
    separatorColumns(quiet),
  );
});

test("the done row puts the completion time immediately after its status", () => {
  const endedAt = new Date(2026, 7, 7, 9, 5, 3).getTime();
  const line = buildCyberDoneLine(
    snapshot({ status: "done", elapsedMs: 48_800, turnCount: 3, endedAt }),
    DEFAULT_WORKING,
    plainTheme,
    new Date(2026, 7, 7, 12).getTime(),
  );
  assert.match(plain(line), /^✓ done at 09:05:03 · 48\.8s/);
});

test("a done row with no end time, or the column switched off, omits it", () => {
  const base = snapshot({ status: "done", elapsedMs: 1_000, turnCount: 1 });
  assert.equal(
    buildCyberDoneLine(base, DEFAULT_WORKING, plainTheme).includes(" at "),
    false,
    "没有结束时间就不画",
  );
  const withEnd = { ...base, endedAt: Date.now() };
  assert.equal(
    buildCyberDoneLine(
      withEnd,
      { ...DEFAULT_WORKING, showFinishedAt: false },
      plainTheme,
    ).includes(" at "),
    false,
    "开关关掉就不画",
  );
});

test("the clock pads to a fixed width so the column does not jitter", () => {
  const at = (h: number, m: number, s: number) =>
    buildCyberDoneLine(
      snapshot({ status: "done", elapsedMs: 1, endedAt: new Date(2026, 7, 7, h, m, s).getTime() }),
      DEFAULT_WORKING,
      plainTheme,
      new Date(2026, 7, 7, 12).getTime(),
    ).split(" at ")[1]!.split(" · ")[0]!;
  assert.equal(plain(at(9, 5, 3)), "09:05:03");
  assert.equal(plain(at(23, 59, 59)), "23:59:59");
  assert.equal(plain(at(0, 0, 0)), "00:00:00");
});

test("a done row includes the local date when it did not finish today", () => {
  const endedAt = new Date(2026, 7, 7, 23, 59, 59).getTime();
  const line = buildCyberDoneLine(
    snapshot({ status: "done", elapsedMs: 1_000, endedAt }),
    DEFAULT_WORKING,
    plainTheme,
    new Date(2026, 7, 8, 0, 0, 1).getTime(),
  );
  assert.match(plain(line), /^✓ done at 2026-08-07 23:59:59 · 1\.0s/);
});
