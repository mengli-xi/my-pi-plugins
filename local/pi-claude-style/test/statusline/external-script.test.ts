import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ContributedRows } from "../../src/statusline/extra-lines.ts";

const STATUSLINE_SCRIPT = fileURLToPath(new URL("../../../../assets/statusline.mjs", import.meta.url));
const ANSI = /\x1b\[[0-9;]*m/g;

function statusLines(
  width: number,
  cwd: string,
  sessionFile: string,
  contextWindow: Record<string, unknown> = {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    context_window_size: 200_000,
    current_usage: {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
): string[] {
  const payload = {
    cwd,
    workspace: { current_dir: cwd },
    pi: {
      session_file: sessionFile,
      session_started_at_ms: 1_000,
      refreshed_at_ms: 125_000,
    },
    model: { id: "gpt-fixture-max", provider: "demo" },
    terminal: { width },
    context_window: contextWindow,
    cost: { total_duration_ms: 124_000 },
  };
  const result = spawnSync(STATUSLINE_SCRIPT, [], {
    cwd,
    env: { ...process.env, MY_PI_STATUSLINE_CACHE_DIR: join(cwd, ".statusline-cache") },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd().split("\n").map((line) => line.replace(ANSI, ""));
}

function firstLine(width: number, cwd: string, sessionFile: string): string {
  return statusLines(width, cwd, sessionFile)[0]!;
}

function substitutePath(line: string, cwd: string): string {
  const rows = new ContributedRows();
  rows.handle({ key: "path-full", line: cwd, placement: "slot" });
  rows.handle({ key: "path-short", line: basename(cwd), placement: "slot" });
  return rows.composeSlots([line]).lines[0]!.replace(ANSI, "");
}

test("the external statusline delegates cache quality while preserving cumulative cache totals", () => {
  const root = mkdtempSync(join(tmpdir(), "statusline-cache-slot-"));
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, "");
  try {
    const lines = statusLines(100, root, sessionFile, {
      total_input_tokens: 1_000,
      total_output_tokens: 100,
      total_cache_read_tokens: 9_000,
      total_cache_write_tokens: 500,
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 9_000,
      },
    });
    assert.match(lines[1] ?? "", /R:9k·W:500/);
    assert.match(lines[1] ?? "", /\t\[\[pi:slot:cache-quality\]\]$/);
    assert.doesNotMatch(lines[1] ?? "", /CH:|RU:|M:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit zero cache totals do not fall back to inactive session branches", () => {
  const root = mkdtempSync(join(tmpdir(), "statusline-cache-zero-"));
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 1_000, output: 100, cacheRead: 9_000, cacheWrite: 500 },
    },
  })}\n`);
  try {
    const lines = statusLines(100, root, sessionFile);
    assert.match(lines[1] ?? "", /R:0·W:0/);
    assert.doesNotMatch(lines[1] ?? "", /R:9k|W:500/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy payloads missing cache totals still use the session fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "statusline-cache-legacy-"));
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 1_000, output: 100, cacheRead: 9_000, cacheWrite: 500 },
    },
  })}\n`);
  try {
    const lines = statusLines(100, root, sessionFile, {
      context_window_size: 200_000,
      current_usage: null,
    });
    assert.match(lines[1] ?? "", /R:9k·W:500/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the external statusline preserves the directory basename before turn and compact counters", () => {
  const root = mkdtempSync(join(tmpdir(), "statusline-width-"));
  const cwd = join(root, "very-long-parent", "complete-directory-name");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(sessionFile, [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "user" } },
    { type: "compaction" },
    { type: "compaction" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  try {
    const wide = substitutePath(firstLine(100, cwd, sessionFile), cwd);
    assert.match(wide, /complete-directory-name/);
    assert.match(wide, /#2/);
    assert.match(wide, /C×2/);
    assert.match(wide, /2m04s/);
    assert.doesNotMatch(wide, /S:/);
    assert.doesNotMatch(wide, /compact×/);

    const medium = substitutePath(firstLine(60, cwd, sessionFile), cwd);
    assert.match(medium, /complete-directory-name/);
    assert.doesNotMatch(medium, /#2|C×2/);
    assert.match(medium, /2m04s/);

    const narrowSource = firstLine(50, cwd, sessionFile);
    assert.match(narrowSource, /\[\[pi:slot:path-short@\d+\]\]/);
    const narrow = substitutePath(narrowSource, cwd);
    assert.doesNotMatch(narrow, /#2|C×2/);
    assert.match(narrow, /…/);
    assert.doesNotMatch(narrow, /complete-directory-name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
