import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";

import {
  clipboardImageMarkdownTransformer,
  isPiClipboardImagePath,
  replaceClipboardImagePaths,
} from "../src/image-marker.ts";

initTheme("dark");

const FIRST = "/var/folders/test/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png";
const SECOND = "/tmp/pi-clipboard-223e4567-e89b-12d3-a456-426614174000.webp";

test("recognizes only Pi clipboard image paths", () => {
  assert.equal(isPiClipboardImagePath(FIRST), true);
  assert.equal(isPiClipboardImagePath("/tmp/screenshot.png"), false);
  assert.equal(isPiClipboardImagePath(`${FIRST} trailing`), false);
});

test("replaces clipboard paths with per-message image markers", () => {
  assert.equal(
    replaceClipboardImagePaths(`before ${FIRST}\nafter ${SECOND}`),
    "before [Image #1]\nafter [Image #2]",
  );
});

test("Markdown transform changes only user presentation", () => {
  const source = `inspect ${FIRST}`;
  assert.equal(
    clipboardImageMarkdownTransformer(source, {
      messageType: "user",
      isStreaming: false,
      availableWidth: 40,
    }),
    "inspect `[Image #1]`",
  );
  const rendered = new UserMessageComponent(
    source,
    undefined,
    1,
    [clipboardImageMarkdownTransformer],
  ).render(40).join("\n");
  assert.match(rendered, /\[Image #1\]/u);
  assert.doesNotMatch(rendered, /pi-clipboard-/u);
  assert.equal(
    clipboardImageMarkdownTransformer(source, {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 40,
    }),
    source,
  );
});
