import type { Theme } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import {
	Image,
	Key,
	matchesKey,
	setCapabilities,
	setCellDimensions,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type CellDimensions,
	type Component,
	type Focusable,
	type TerminalCapabilities,
	type TUI,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "./clipboard.ts";
import { panelFooterRule } from "pi-li-uikit/panel-footer";

export interface ImagePanelItem {
	data?: string;
	mimeType?: string;
	label: string;
	path?: string;
	unavailableReason?: string;
}

export interface ImagePanelOptions {
	tui: TUI;
	theme: Theme;
	title?: string;
	items: readonly ImagePanelItem[];
	capabilities?: TerminalCapabilities;
	cellDimensions?: CellDimensions;
	onClose: () => void;
	copy?: (text: string) => void | Promise<void>;
	open?: (path: string) => void | Promise<void>;
}

interface CachedImage {
	index: number;
	width: number;
	height: number;
	component: Image;
}

const UNSAFE_TERMINAL_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function imageOpenSpec(path: string, host: NodeJS.Platform = platform()): { command: string; args: string[] } {
	if (host === "darwin") return { command: "open", args: [path] };
	if (host === "win32") return { command: "explorer.exe", args: [path] };
	return { command: "xdg-open", args: [path] };
}

/** Open one image path with the platform default application. */
export function openImagePath(path: string): Promise<void> {
	const { command, args } = imageOpenSpec(path);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/** Strip terminal commands and make remaining control characters visible. */
export function sanitizeImagePanelText(value: string): string {
	return stripTerminalSequences(value).replace(UNSAFE_TERMINAL_TEXT, "�");
}

function titleRule(theme: Theme, title: string, width: number): string {
	if (width < 4) return theme.fg("accent", "─".repeat(width));
	const label = truncateToWidth(` ▣ ${title} `, Math.max(0, width - 2), "…", true);
	return theme.fg(
		"accent",
		`${"─".repeat(Math.max(0, width - visibleWidth(label)))}${theme.bold(label)}`,
	);
}

function fitRenderedImageLine(line: string, width: number): string {
	if (line.startsWith("\x1b_G") || line.startsWith("\x1b]1337;File=")) return line;
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…", true);
}

/**
 * Editor-replacement image viewer.
 *
 * This is deliberately not an overlay. Pi's overlay compositor treats an
 * image's reserved empty rows as ordinary cells and fills them from the layer
 * below, so regular-TUI image height accounting collapses. A custom editor
 * component reaches Pi's native regular/fullscreen image renderers unchanged.
 */
export class ImagePanel implements Component, Focusable {
	private readonly options: ImagePanelOptions;
	private _focused = false;
	private index = 0;
	private availableHeight: number | undefined;
	private cache: CachedImage | undefined;
	private notice: string | undefined;
	private pendingAction: Promise<void> | undefined;
	private closed = false;

	constructor(options: ImagePanelOptions) {
		this.options = {
			...options,
			title: options.title === undefined ? undefined : sanitizeImagePanelText(options.title),
			items: options.items.map((item) => ({
				...item,
				label: sanitizeImagePanelText(item.label),
				mimeType: item.mimeType === undefined ? undefined : sanitizeImagePanelText(item.mimeType),
				unavailableReason: item.unavailableReason === undefined
					? undefined
					: sanitizeImagePanelText(item.unavailableReason),
			})),
		};
		if (options.capabilities) setCapabilities(options.capabilities);
		if (options.cellDimensions) setCellDimensions(options.cellDimensions);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	setAvailableHeight(rows: number): void {
		if (!Number.isFinite(rows) || rows < 1) return;
		this.availableHeight = Math.max(1, Math.floor(rows));
		this.cache = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		const terminalRows = Math.max(1, Math.floor(this.options.tui.terminal.rows));
		const availableRows = Math.max(
			5,
			Math.min(
				this.availableHeight ?? terminalRows,
				Math.max(5, Math.floor(terminalRows * 0.7)),
			),
		);
		const imageRows = Math.max(1, availableRows - 4);
		const item = this.options.items[this.index];
		const title = this.panelTitle(item);
		const body = item ? this.renderItem(item, safeWidth, imageRows) : [
			this.options.theme.fg("muted", "No image available"),
		];
		// A tool's in-memory image has no file behind it: offer only what works.
		const pathHints = item?.path ? ["y copy path · o open · ", "y copy · o open · "] : ["", ""];
		const footer = safeWidth < 8
			? this.options.theme.fg("muted", "─".repeat(safeWidth))
			: this.notice
				? panelFooterRule(this.options.theme, safeWidth, [this.notice])
				: this.options.items.length > 1
					? panelFooterRule(this.options.theme, safeWidth, [
						`←/→ images · ${pathHints[0]}Esc close`,
						`←/→ · ${pathHints[1]}Esc`,
					])
					: panelFooterRule(this.options.theme, safeWidth, [
						`${pathHints[0]}Esc close`,
						`${pathHints[1]}Esc`,
					]);
		const lines = [titleRule(this.options.theme, title, safeWidth), "", ...body, "", footer];
		return lines;
	}

	handleInput(data: string): void {
		if (!this._focused || this.closed) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		this.notice = undefined;
		if (data === "y") {
			this.copyPath();
			return;
		}
		if (data === "o") {
			this.openPath();
			return;
		}
		if (this.options.items.length < 2) return;
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "k") {
			this.select(this.index - 1);
		} else if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "j") {
			this.select(this.index + 1);
		}
	}

	invalidate(): void {
		this.cache?.component.invalidate();
		this.cache = undefined;
	}

	dispose(): void {
		this.closed = true;
		this.cache = undefined;
	}

	/** Lets hosts and tests await the current clipboard/open action. */
	async waitForPending(): Promise<void> {
		await this.pendingAction;
	}

	private panelTitle(item: ImagePanelItem | undefined): string {
		const base = this.options.title ?? "Image preview";
		if (!item) return base;
		return this.options.items.length > 1
			? `${base} ${this.index + 1}/${this.options.items.length} · ${item.label}`
			: `${base} · ${item.label}`;
	}

	private renderItem(item: ImagePanelItem, width: number, height: number): string[] {
		if (!item.data || !item.mimeType) {
			const message = truncateToWidth(
				item.unavailableReason ?? "Image preview unavailable",
				width,
				"…",
				true,
			);
			return [this.options.theme.fg("warning", message)];
		}
		const cached = this.cache;
		if (cached && cached.index === this.index && cached.width === width && cached.height === height) {
			return cached.component.render(width).map((line) => fitRenderedImageLine(line, width));
		}
		const component = new Image(
			item.data,
			item.mimeType,
			{ fallbackColor: (text) => this.options.theme.fg("muted", text) },
			{
				maxWidthCells: Math.max(1, width - 4),
				maxHeightCells: height,
				filename: item.label,
			},
		);
		this.cache = { index: this.index, width, height, component };
		return component.render(width).map((line) => fitRenderedImageLine(line, width));
	}

	private select(index: number): void {
		const count = this.options.items.length;
		if (count < 2) return;
		this.index = (index + count) % count;
		this.cache = undefined;
		this.options.tui.requestRender();
	}

	private act(
		verb: "copy" | "open",
		action: (path: string) => void | Promise<void>,
	): void {
		const path = this.options.items[this.index]?.path;
		if (!path) {
			this.notice = "Path unavailable";
			this.options.tui.requestRender();
			return;
		}
		this.notice = verb === "copy" ? "Copied image path" : "Opened image";
		this.pendingAction = Promise.resolve()
			.then(() => action(path))
			.catch(() => {
				if (!this.closed) this.notice = verb === "copy" ? "Copy failed" : "Open failed";
			})
			.finally(() => {
				if (!this.closed) this.options.tui.requestRender();
			});
		this.options.tui.requestRender();
	}

	private copyPath(): void {
		this.act("copy", this.options.copy ?? copyToClipboard);
	}

	private openPath(): void {
		this.act("open", this.options.open ?? openImagePath);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.options.onClose();
	}
}

export interface ImagePanelContext {
	mode: string;
	hasUI: boolean;
	ui: {
		custom<T>(factory: (
			tui: TUI,
			theme: Theme,
			keybindings: unknown,
			done: (value: T) => void,
		) => Component): Promise<T>;
	};
}

/** Replace the editor with an image-safe panel; Pi restores editor focus on close. */
export async function showImagePanel(
	ctx: ImagePanelContext,
	options: Omit<ImagePanelOptions, "tui" | "theme" | "onClose">,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new ImagePanel({ ...options, tui, theme, onClose: done })
	);
}
