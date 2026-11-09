import assert from "node:assert/strict";
import test from "node:test";

import { captureResult } from "../src/capture-result.ts";
import {
  formatImageBytes,
  imageActionLabel,
  imagePanelHeading,
  toolResultImagePreviews,
} from "../src/image-preview.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5p6cAAAAASUVORK5CYII=";
const BYTES = Buffer.from(PNG, "base64").byteLength;

test("captures how many images a result carried, not the payload", () => {
  const captured = captureResult({
    content: [
      { type: "text", text: "screenshot taken" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
  }, false, 10_000);

  assert.deepEqual(captured.imageSummary, { count: 1, totalBytes: BYTES });
  assert.ok(!JSON.stringify(captured).includes(PNG));
});

test("only a read names the previewed image by its path", () => {
  const content = [{ type: "image", data: PNG, mimeType: "image/png" }];
  assert.deepEqual(toolResultImagePreviews("read", { path: "shot.png" }, content), [
    { data: PNG, mimeType: "image/png", sizeBytes: BYTES, path: "shot.png" },
  ]);
  assert.deepEqual(toolResultImagePreviews("mcp__browser__screenshot", { path: "/tmp" }, content), [
    { data: PNG, mimeType: "image/png", sizeBytes: BYTES },
  ]);
  assert.deepEqual(toolResultImagePreviews("read", { path: "a.txt" }, [{ type: "text", text: "a" }]), []);
});

test("formats compact image labels and panel titles", () => {
  assert.equal(formatImageBytes(1023), "1023 B");
  assert.equal(formatImageBytes(1024), "1 KB");
  assert.equal(formatImageBytes(1536), "1.5 KB");
  assert.equal(formatImageBytes(1024 * 1024), "1 MB");
  assert.equal(imageActionLabel({ count: 1, totalBytes: 123 * 1024 }), "View Image (123 KB)");
  assert.equal(imageActionLabel({ count: 3, totalBytes: 420 * 1024 }), "View 3 Images (420 KB)");
  assert.equal(imagePanelHeading([{ data: PNG, mimeType: "image/png", sizeBytes: 68, path: "screen.png" }]), "Image");
});
