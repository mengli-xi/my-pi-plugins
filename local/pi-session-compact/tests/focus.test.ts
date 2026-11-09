import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectFocus } from "../src/focus.ts";

test("focus supplements ordinary Markdown summaries without retired schema or memory rules", () => {
  const root = mkdtempSync(join(tmpdir(), "compact-focus-"));
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    const focus = collectFocus(cwd, agentDir, "保留当前限制，不要部署");
    assert.match(focus.mergedText, /supplement only/);
    assert.match(focus.mergedText, /do not replace base instructions, user-message coverage or validation/);
    assert.match(focus.mergedText, /Preserve active restrictions/);
    assert.match(focus.mergedText, /report unresolved conflicts/);
    assert.match(focus.mergedText, /Do not execute commands or modify files/);
    assert.match(focus.mergedText, /保留当前限制，不要部署/);
    assert.doesNotMatch(focus.mergedText, /output schema|paste placeholders|review-only memory policy/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
