import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GROUPING,
  DEFAULT_IMPORTANT_TOOLS,
} from "../src/config.ts";
import { resolveToolPresentation } from "../src/presentation-policy.ts";

const defaults = {
  grouping: { ...DEFAULT_GROUPING },
  importantTools: { ...DEFAULT_IMPORTANT_TOOLS },
};

test("resolves important tools before semantic grouping", () => {
  assert.equal(
    resolveToolPresentation("ask_user_question", {}, defaults).kind,
    "question",
  );
  assert.equal(
    resolveToolPresentation("web_search", {}, defaults).kind,
    "web-search",
  );
  assert.equal(
    resolveToolPresentation("web_fetch", {}, defaults).kind,
    "web-fetch",
  );
  assert.equal(
    resolveToolPresentation("edit", { path: "x.ts" }, defaults).kind,
    "single-file-edit",
  );
  assert.equal(resolveToolPresentation("bash", {}, defaults).kind, "grouped");
});

test("returns disabled important tools to existing grouping policy", () => {
  const config = {
    grouping: { ...DEFAULT_GROUPING, search: false, edit: false },
    importantTools: {
      ...DEFAULT_IMPORTANT_TOOLS,
      webSearch: false,
      singleFileEdit: false,
    },
  };
  assert.equal(resolveToolPresentation("web_search", {}, config).kind, "native");
  assert.equal(resolveToolPresentation("edit", {}, config).kind, "native");
  assert.equal(resolveToolPresentation("unknown_x", {}, defaults).kind, "grouped");
});

test("leaves todo tools on their own renderer", () => {
  assert.deepEqual(
    resolveToolPresentation("todowrite", { todos: [] }, {
      grouping: DEFAULT_GROUPING,
      importantTools: DEFAULT_IMPORTANT_TOOLS,
    }),
    { kind: "native" },
  );
  assert.deepEqual(
    resolveToolPresentation("todowrite", { todos: [] }, {
      grouping: DEFAULT_GROUPING,
      importantTools: { ...DEFAULT_IMPORTANT_TOOLS, todoList: false },
    }),
    { kind: "grouped" },
  );
});

test("groups Magic Context memory and note tools", () => {
  const config = {
    grouping: DEFAULT_GROUPING,
    importantTools: DEFAULT_IMPORTANT_TOOLS,
  };
  for (const name of ["ctx_search", "ctx_memory", "ctx_note", "ctx_reduce"]) {
    assert.deepEqual(resolveToolPresentation(name, {}, config), {
      kind: "grouped",
    });
  }
});
