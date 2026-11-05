import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	setCapabilities,
	setCellDimensions,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	ImagePanel,
	imageOpenSpec,
	sanitizeImagePanelText,
	showImagePanel,
} from "../src/image-panel.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5p6cAAAAASUVORK5CYII=";

function png(width: number, height: number): string {
	const buffer = Buffer.alloc(24);
	buffer[0] = 0x89;
	buffer[1] = 0x50;
	buffer[2] = 0x4e;
	buffer[3] = 0x47;
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer.toString("base64");
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function tui(mode: "regular" | "fullscreen" = "regular"): TUI {
	return {
		mode,
		terminal: { rows: 24, columns: 80, write() {} },
		requestRender() {},
	} as unknown as TUI;
}

test("keeps Pi image rows unwrapped so height metadata stays valid", () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	const panel = new ImagePanel({
		tui: tui(),
		theme,
		items: [{ data: png(640, 480), mimeType: "image/png", label: "screen.png" }],
		onClose() {},
	});
	const lines = panel.render(80);
	const imageAt = lines.findIndex((line) => line.includes("\x1b_G"));
	assert.ok(imageAt >= 0);
	assert.ok(lines[imageAt]!.startsWith("\x1b_G"));
	const rows = Number(/(?:^|,)r=(\d+)(?:,|;)/u.exec(lines[imageAt]!)?.[1]);
	assert.ok(rows > 1);
	assert.equal(lines.slice(imageAt + 1, imageAt + rows).every((line) => line === ""), true);
});

test("switches among multiple images and closes from Escape", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	let closed = 0;
	let renders = 0;
	const host = tui();
	(host as unknown as { requestRender(): void }).requestRender = () => { renders++; };
	const panel = new ImagePanel({
		tui: host,
		theme,
		items: [
			{ data: PNG, mimeType: "image/png", label: "one.png" },
			{ data: PNG, mimeType: "image/png", label: "two.png" },
		],
		onClose: () => { closed++; },
	});
	panel.focused = true;
	assert.match(panel.render(80)[0]!, /1\/2 · one\.png/u);
	panel.handleInput("\x1b[C");
	assert.match(panel.render(80)[0]!, /2\/2 · two\.png/u);
	assert.equal(renders, 1);
	panel.handleInput("\x1b");
	assert.equal(closed, 1);
});

test("copies and opens the current image path without closing", async () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const copied: string[] = [];
	const opened: string[] = [];
	let closed = 0;
	const panel = new ImagePanel({
		tui: tui(),
		theme,
		items: [
			{ data: PNG, mimeType: "image/png", label: "one.png", path: "/tmp/one.png" },
			{ data: PNG, mimeType: "image/png", label: "two.png", path: "/tmp/two.png" },
		],
		copy: (path) => { copied.push(path); },
		open: (path) => { opened.push(path); },
		onClose: () => { closed++; },
	});
	panel.focused = true;
	panel.handleInput("\x1b[C");
	panel.handleInput("y");
	await panel.waitForPending();
	assert.deepEqual(copied, ["/tmp/two.png"]);
	assert.match(panel.render(80).at(-1)!, /Copied image path/u);
	panel.handleInput("o");
	await panel.waitForPending();
	assert.deepEqual(opened, ["/tmp/two.png"]);
	assert.match(panel.render(80).at(-1)!, /Opened image/u);
	assert.equal(closed, 0);
});

test("reports an unavailable path without invoking an action", async () => {
	let copies = 0;
	const panel = new ImagePanel({
		tui: tui(),
		theme,
		items: [{ data: PNG, mimeType: "image/png", label: "memory image" }],
		copy: () => { copies++; },
		onClose() {},
	});
	panel.focused = true;
	assert.doesNotMatch(panel.render(80).at(-1)!, /copy|open/u, "no path, no path actions offered");
	panel.handleInput("y");
	await panel.waitForPending();
	assert.equal(copies, 0);
	assert.match(panel.render(80).at(-1)!, /Path unavailable/u);
});

test("opens paths as one platform argument", () => {
	assert.deepEqual(imageOpenSpec("/tmp/image with spaces.png", "darwin"), {
		command: "open",
		args: ["/tmp/image with spaces.png"],
	});
	assert.deepEqual(imageOpenSpec("/tmp/image.png", "linux"), {
		command: "xdg-open",
		args: ["/tmp/image.png"],
	});
	assert.deepEqual(imageOpenSpec("C:\\image.png", "win32"), {
		command: "explorer.exe",
		args: ["C:\\image.png"],
	});
});

test("sanitizes untrusted labels before they reach terminal output", () => {
	const malicious = "evil\x1b]52;c;SGVsbG8=\x07\n\u202enext.png";
	assert.equal(sanitizeImagePanelText(malicious), "evil��next.png");

	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const rendered = new ImagePanel({
		tui: tui(),
		theme,
		title: `Preview ${malicious}`,
		items: [{
			data: PNG,
			mimeType: `image/png${malicious}`,
			label: malicious,
			unavailableReason: malicious,
		}],
		onClose() {},
	}).render(80).join("\n");
	assert.doesNotMatch(rendered, /\x1b\]52/u);
	assert.doesNotMatch(rendered, /\u202e/u);
	assert.doesNotMatch(rendered, /SGVsbG8=/u);
});

test("never renders ordinary panel rows wider than the host", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const panel = new ImagePanel({
		tui: tui(),
		theme,
		title: "Image preview",
		items: [{ label: "very-long-image-name.png", unavailableReason: "Image preview unavailable" }],
		onClose() {},
	});
	for (const width of [1, 2, 4, 7]) {
		for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
	}
});

test("showImagePanel uses Pi's editor replacement lifecycle", async () => {
	let optionsSeen: unknown = "not-called";
	let component: ImagePanel | undefined;
	const ctx: Parameters<typeof showImagePanel>[0] = {
		mode: "tui",
		hasUI: true,
		ui: {
			async custom<T>(factory: (
				tui: TUI,
				theme: Theme,
				keybindings: unknown,
				done: (value: T) => void,
			) => import("@earendil-works/pi-tui").Component) {
				optionsSeen = undefined;
				component = factory(tui(), theme, {}, () => {}) as ImagePanel;
				return undefined as T;
			},
		},
	};
	await showImagePanel(ctx, {
		items: [{ data: PNG, mimeType: "image/png", label: "screen.png" }],
	});
	assert.equal(optionsSeen, undefined, "image protocol lines must not enter the overlay compositor");
	assert.ok(component instanceof ImagePanel);
	assert.equal("wantsMouse" in component, false, "non-overlay image panels leave mouse selection to the viewport");
});
