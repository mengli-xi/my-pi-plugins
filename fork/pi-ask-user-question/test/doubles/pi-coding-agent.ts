/**
 * Test-only stand-in for the `@earendil-works/pi-coding-agent` peer dependency,
 * mapped from the bare specifier by `test/ts-resolve.mjs` for the same reason as
 * the pi-tui double: the fork declares it as a peer and never installs it.
 *
 * `view/dialog-builder.ts` pulls `DynamicBorder` at module scope, so a test that
 * only wants `buildHintText` still needs the symbol to exist. Themes are plain
 * pass-through so assertions read the raw hint text.
 */

export class DynamicBorder {
	private readonly style: (text: string) => string;
	constructor(style: (text: string) => string = (t) => t) {
		this.style = style;
	}
	render(width: number): string[] {
		return [this.style("─".repeat(Math.max(1, width)))];
	}
	invalidate(): void {}
	handleInput(_data: string): void {}
}

export interface Theme {
	fg(_color: string, text: string): string;
	bg(_color: string, text: string): string;
	bold(text: string): string;
}

/** Identity theme: every style function returns its input unchanged. */
export const passthroughTheme: Theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

export function getMarkdownTheme(): Record<string, never> {
	return {};
}
