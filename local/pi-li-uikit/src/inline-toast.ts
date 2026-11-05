import {
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import type {
	ExtensionUIContext,
	Theme,
	WidgetPlacement,
} from "@earendil-works/pi-coding-agent";

export type InlineToastTone = "info" | "success" | "warning" | "error";

export interface InlineToastOptions {
	message: string;
	theme: Theme;
	tone?: InlineToastTone;
	paddingX?: number;
}

export interface InlineToastShowOptions {
	tone?: InlineToastTone;
	durationMs?: number;
}

export interface InlineToastControllerOptions {
	key?: string;
	placement?: WidgetPlacement;
	schedule?: (callback: () => void, delayMs: number) => () => void;
}

function toneColor(tone: InlineToastTone): Parameters<Theme["fg"]>[0] {
	switch (tone) {
		case "success":
			return "success";
		case "warning":
			return "warning";
		case "error":
			return "error";
		default:
			return "accent";
	}
}

/**
 * One centered transient line for the conversation/editor boundary.
 *
 * The owner controls mounting and lifetime; this component owns only width-safe
 * presentation so processes, side sessions, and future transient notices share
 * one visual grammar without sharing lifecycle state.
 */
export class InlineToast implements Component {
	private readonly options: InlineToastOptions;

	constructor(options: InlineToastOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const padding = Math.max(0, this.options.paddingX ?? 1);
		const contentWidth = Math.max(1, safeWidth - padding * 2);
		const message = truncateToWidth(this.options.message.trim(), contentWidth, "…");
		const centered = `${" ".repeat(Math.floor(Math.max(0, contentWidth - visibleWidth(message)) / 2))}${message}`;
		const text = this.options.theme.fg(
			toneColor(this.options.tone ?? "info"),
			this.options.theme.bold(centered),
		);
		return [`${" ".repeat(padding)}${text}`];
	}

	invalidate(): void {}
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
	const timer = setTimeout(callback, delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
}

/** Mount, replace, expire, and clear one transient editor-boundary toast. */
export class InlineToastController {
	private readonly ui: Pick<ExtensionUIContext, "setWidget">;
	private readonly key: string;
	private readonly placement: WidgetPlacement;
	private readonly schedule: (callback: () => void, delayMs: number) => () => void;
	private cancelExpiry: (() => void) | undefined;

	constructor(
		ui: Pick<ExtensionUIContext, "setWidget">,
		options: InlineToastControllerOptions = {},
	) {
		this.ui = ui;
		this.key = options.key ?? "pi-li-uikit:inline-toast";
		this.placement = options.placement ?? "aboveEditor";
		this.schedule = options.schedule ?? scheduleTimeout;
	}

	show(message: string, options: InlineToastShowOptions = {}): void {
		this.cancelExpiry?.();
		this.cancelExpiry = undefined;
		this.ui.setWidget(
			this.key,
			(_tui, theme) => new InlineToast({
				message,
				theme,
				tone: options.tone,
			}),
			{ placement: this.placement },
		);
		const durationMs = options.durationMs ?? 5_000;
		if (durationMs > 0) {
			this.cancelExpiry = this.schedule(() => this.clear(), durationMs);
		}
	}

	clear(): void {
		this.cancelExpiry?.();
		this.cancelExpiry = undefined;
		this.ui.setWidget(this.key, undefined, { placement: this.placement });
	}

	dispose(): void {
		this.clear();
	}
}
