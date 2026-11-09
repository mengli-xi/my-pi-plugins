import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config.ts";
import { captureResult } from "../src/capture-result.ts";
import { formatDuration, formatTokenCount, truncateText } from "../src/format.ts";

test("normalizes config independently and clamps ranges", () => {
  const config = normalizeConfig({
    expandMode: "inline",
    maxGroups: 1,
    grouping: { bash: false },
    importantTools: {
      webSearch: false,
      webFetch: "invalid",
      webDetails: "inline",
    },
    overlay: {
      verticalPadding: 99,
      mouseScrollLines: 99,
      background: "selectedBg",
    },
    separators: {
      showTurnSeparators: false,
      replaceDoneWidget: false,
    },
    working: {
      style: "cyber",
      refreshMs: 5,
      spinnerIntervalMs: 5,
      verbRotateMs: 999_999,
      messageWidth: 10,
    },
    userMessages: { verticalPadding: 99, title: "" },
    assistantMessages: {
      marker: "◆",
      markerColor: "muted",
    },
  });
  assert.equal(config.expandMode, "inline");
  assert.equal(config.maxGroups, 10);
  assert.equal(config.grouping.bash, false);
  assert.equal(config.grouping.read, true);
  assert.equal(config.importantTools.webSearch, false);
  assert.equal(config.importantTools.webFetch, true);
  assert.equal(config.importantTools.askUserQuestion, true);
  assert.equal(config.importantTools.webDetails, "overlay");

  assert.equal(config.overlay.mouseScrollLines, 20);

  assert.equal(config.separators.enabled, true);
  assert.equal(config.separators.showTurnSeparators, false);
  assert.equal(config.separators.showRunSeparator, true);
  assert.equal(config.separators.replaceDoneWidget, false);
  assert.equal(config.working.style, "cyber");
  assert.equal(config.working.refreshMs, 75);
  assert.equal(config.working.spinnerIntervalMs, 80);
  assert.equal(config.working.verbRotateMs, 120_000);
  assert.equal(config.working.messageWidth, 40);
  assert.equal(config.userMessages.verticalPadding, 3);
  assert.equal(config.userMessages.title, "user");
  assert.equal(config.assistantMessages.style, "claude");
  assert.equal(config.assistantMessages.marker, "◆");
  assert.equal(config.assistantMessages.markerColor, "muted");
  assert.equal(config.assistantMessages.collapsedThinking, "activity");
  assert.equal("integrations" in config, false);
});

test("uses a render-safe working refresh rate by default", () => {
  assert.equal(normalizeConfig({}).working.refreshMs, 120);
  assert.equal(normalizeConfig({}).working.spinnerIntervalMs, 180);
});

test("legacy shared diff highlights seed both operation-specific colours", () => {
  const config = normalizeConfig({ diff: { highlightBg: 90 } });
  assert.equal(config.diff.addedHighlightBg, 90);
  assert.equal(config.diff.removedHighlightBg, 90);
  assert.equal("highlightBg" in config.diff, false);
});

test("formats durations and token counts compactly", () => {
  assert.equal(formatDuration(1_200), "1.2s");
  assert.equal(formatDuration(1_000), "1.0s");
  assert.equal(formatDuration(28_000), "28.0s");
  assert.equal(formatDuration(60_000), "1m00s");
  assert.equal(formatDuration(61_000), "1m01s");
  assert.equal(formatDuration(125_900), "2m05s");
  assert.equal(formatDuration(3_600_000), "1h00m00s");
  assert.equal(formatDuration(3_661_000), "1h01m01s");
  assert.equal(formatDuration(12_725_900), "3h32m05s");
  assert.equal(formatTokenCount(8_300), "8.3k");
});

test("truncates captured content deterministically", () => {
  assert.deepEqual(truncateText("abc", 3), { text: "abc", truncated: false });
  assert.equal(truncateText("abcd", 3).truncated, true);
});

test("preserves bounded structured tool details", () => {
  const details = {
    answers: [{ questionIndex: 0, answer: "Singapore" }],
    cancelled: false,
  };
  assert.deepEqual(
    captureResult(
      { content: [{ type: "text", text: "answered" }], details },
      false,
      1_000,
    ).details,
    details,
  );
});
