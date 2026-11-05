import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { InlineToast, InlineToastController } from "../src/inline-toast.ts";

const calls: Array<{ color: string; text: string }> = [];
const theme = {
	fg: (color: string, text: string) => {
		calls.push({ color, text });
		return text;
	},
	bold: (text: string) => text,
} as unknown as Theme;

test("renders a centered width-safe transient line", () => {
	calls.length = 0;
	const [line] = new InlineToast({ message: "Main finished", theme, tone: "success" }).render(30);
	assert.equal(visibleWidth(line ?? "") <= 30, true);
	assert.equal((line ?? "").trim(), "Main finished");
	assert.equal((line ?? "").indexOf("Main finished") > 1, true);
	assert.equal(calls[0]?.color, "success");
});

test("truncates instead of wrapping into the editor", () => {
	const lines = new InlineToast({ message: "A very long transient message", theme }).render(12);
	assert.equal(lines.length, 1);
	assert.equal(visibleWidth(lines[0] ?? "") <= 12, true);
	assert.match(lines[0] ?? "", /…/u);
});

test("controller replaces, expires, and clears one shared widget", () => {
	const writes: Array<{ key: string; content: unknown }> = [];
	let expire: (() => void) | undefined;
	let cancelled = 0;
	const controller = new InlineToastController({
		setWidget(key: string, content: unknown) {
			writes.push({ key, content });
		},
	} as never, {
		key: "toast",
		schedule(callback) {
			expire = callback;
			return () => { cancelled++; };
		},
	});
	controller.show("Main finished", { tone: "success", durationMs: 10 });
	assert.equal(writes[0]?.key, "toast");
	assert.equal(typeof writes[0]?.content, "function");
	expire?.();
	assert.equal(writes.at(-1)?.content, undefined);
	controller.dispose();
	assert.equal(cancelled >= 1, true);
});
