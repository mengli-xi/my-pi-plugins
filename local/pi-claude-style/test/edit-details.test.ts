import assert from "node:assert/strict";
import test from "node:test";
import { getCapturedEditDiff } from "../src/edit-details.ts";
import type { ToolActivity } from "../src/types.ts";

test("extracts a successful edit diff and its file path", () => {
  const activity: ToolActivity = {
    id: "edit-1",
    groupId: "group-1",
    toolName: "edit",
    args: { path: "src/index.ts" },
    status: "completed",
    startedAt: 0,
    endedAt: 1,
    result: {
      text: "Successfully replaced 1 block.",
      truncated: false,
      isError: false,
      details: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
    },
  };

  assert.deepEqual(getCapturedEditDiff(activity), {
    diff: "-1 old\n+1 new",
    filePath: "src/index.ts",
  });
});

test("does not render failed edit details as a success diff", () => {
  const activity: ToolActivity = {
    id: "edit-1",
    groupId: "group-1",
    toolName: "edit",
    args: {},
    status: "failed",
    startedAt: 0,
    result: {
      text: "failed",
      truncated: false,
      isError: true,
      details: { diff: "-1 old\n+1 new" },
    },
  };

  assert.equal(getCapturedEditDiff(activity), undefined);
});
