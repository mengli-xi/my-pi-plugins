import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

export interface CollapsibleRowsOptions {
	summary: string;
	preview?: readonly string[];
	previewLimit?: number;
	expanded?: boolean;
	/** Tool cards may keep a bounded preview visible while their details stay folded. */
	showPreview?: boolean;
	renderMarker?: (marker: "▸" | "▾") => string;
}

/** Shared two-column grammar for a collapsible summary and its nested rows. */
export function renderCollapsibleRows(
	options: CollapsibleRowsOptions,
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const expanded = options.expanded ?? false;
	const marker = expanded ? "▾" : "▸";
	const renderedMarker = options.renderMarker?.(marker) ?? marker;
	const rows = [truncateToWidth(`${renderedMarker} ${options.summary}`, safeWidth, "…")];
	if ((!expanded && !options.showPreview) || !options.preview?.length) return rows;
	const previewLimit = Math.max(0, options.previewLimit ?? 8);
	const visible = options.preview.slice(0, previewLimit);
	for (const line of visible) {
		rows.push(truncateToWidth(`  ${line}`, safeWidth, "…"));
	}
	if (options.preview.length > visible.length) {
		rows.push(truncateToWidth(
			`  … ${options.preview.length - visible.length} more · press o to open overlay`,
			safeWidth,
			"…",
		));
	}
	return rows;
}

export interface CollapsibleBlockOptions extends CollapsibleRowsOptions {
	onOpenOverlay?: () => void | Promise<void>;
	requestRender?: () => void;
}

/** A stable transcript summary with an invocation-local, bounded preview. */
export class CollapsibleBlock implements Component, Focusable {
	private readonly summary: string;
	private readonly previewLimit: number;
	private readonly onOpenOverlay: (() => void | Promise<void>) | undefined;
	private readonly requestRender: (() => void) | undefined;
	private preview: readonly string[] | undefined;
	private expanded: boolean;
	private _focused = false;

	constructor(options: CollapsibleBlockOptions) {
		this.summary = options.summary;
		this.preview = options.preview;
		this.previewLimit = Math.max(0, options.previewLimit ?? 8);
		this.expanded = options.expanded ?? false;
		this.onOpenOverlay = options.onOpenOverlay;
		this.requestRender = options.requestRender;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	setPreview(preview: readonly string[] | undefined): void {
		this.preview = preview;
		this.requestRender?.();
	}

	render(width: number): string[] {
		return renderCollapsibleRows({
			summary: this.summary,
			preview: this.preview,
			previewLimit: this.previewLimit,
			expanded: this.expanded,
		}, width);
	}

	handleInput(data: string): void {
		if (!this._focused) return;
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.expanded = !this.expanded;
			this.requestRender?.();
			return;
		}
		if (matchesKey(data, "o") && this.onOpenOverlay) {
			try {
				void Promise.resolve(this.onOpenOverlay()).catch(() => {});
			} catch {
				// A presentation action must not escape into Pi's input loop.
			}
		}
	}

	invalidate(): void {}
}
