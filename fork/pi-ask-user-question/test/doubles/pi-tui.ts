/**
 * Test-only stand-in for the `@earendil-works/pi-tui` peer dependency.
 *
 * The package declares pi-tui as a peer and never installs it, so importing any
 * view module (or `state/key-router.ts`) from a test would fail to resolve.
 * `test/doubles/register.ts` maps that bare specifier here.
 *
 * Only the surface the modules under test actually touch is implemented, and
 * each piece mirrors the shipped behaviour it stands in for:
 *
 * - `Editor` — the text/cursor surface `QuestionnaireSession` drives through its
 *   effects. `setText` splits on `\n` and parks the cursor at the end of the last
 *   line, matching pi-tui's `setTextInternal`; `handleInput` inserts printable
 *   text at the cursor, which is all the draft tests type.
 * - text helpers — plain-text equivalents. Tests stay on ASCII without ANSI, so
 *   pi-tui's ANSI-aware wrapping is never the thing under test.
 * - `matchesKey` — parses the handful of raw sequences the questionnaire routes
 *   (Tab, Shift+Tab, arrows, Enter, Esc) into pi-tui key ids.
 */

export const CURSOR_MARKER = "\x1b_pi:c\x07";
export function renderFakeCursor(text: string): string {
	return `\x1b_pi:fc\x07${text}\x1b_pi:/fc\x07`;
}

export interface Component {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

const ANSI = /\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g;

export function visibleWidth(str: string): number {
	return str.replace(ANSI, "").length;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	const out: string[] = [];
	for (const logical of text.split("\n")) {
		if (visibleWidth(logical) <= width) {
			out.push(logical);
			continue;
		}
		let rest = logical;
		while (visibleWidth(rest) > width) {
			out.push(rest.slice(0, width));
			rest = rest.slice(width);
		}
		out.push(rest);
	}
	return out;
}

export function truncateToWidth(str: string, width: number, ellipsis = "…", _pad = false): string {
	if (visibleWidth(str) <= width) return str;
	if (width <= 0) return "";
	return str.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
}

/** Mirrors pi-tui's headless multiline editor for the cells the session drives. */
export class Editor implements Component {
	focused = false;
	private lines: string[] = [""];
	private cursorLine = 0;
	private cursorCol = 0;

	constructor(_tui?: unknown, _theme?: unknown) {}

	getText(): string {
		return this.lines.join("\n");
	}

	getLines(): string[] {
		return [...this.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.cursorLine, col: this.cursorCol };
	}

	setText(text: string): void {
		const lines = text.split("\n");
		this.lines = lines.length === 0 ? [""] : lines;
		this.cursorLine = this.lines.length - 1;
		this.cursorCol = this.lines[this.cursorLine]?.length ?? 0;
	}

	/** Printable insertion at the cursor plus `\n` as a hard line break. */
	handleInput(data: string): void {
		for (const ch of data) {
			const line = this.lines[this.cursorLine] ?? "";
			if (ch === "\n" || ch === "\r") {
				this.lines.splice(this.cursorLine, 1, line.slice(0, this.cursorCol), line.slice(this.cursorCol));
				this.cursorLine += 1;
				this.cursorCol = 0;
				continue;
			}
			this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + ch + line.slice(this.cursorCol);
			this.cursorCol += ch.length;
		}
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

export class Spacer implements Component {
	private readonly rows: number;
	constructor(rows = 1) {
		this.rows = rows;
	}
	render(_width: number): string[] {
		return Array<string>(this.rows).fill("");
	}
	invalidate(): void {}
	handleInput(_data: string): void {}
}

export class Text implements Component {
	private readonly text: string;
	private readonly paddingLeft: number;
	constructor(text: string, paddingLeft = 0, _paddingRight = 0) {
		this.text = text;
		this.paddingLeft = paddingLeft;
	}
	render(width: number): string[] {
		const pad = " ".repeat(this.paddingLeft);
		return wrapTextWithAnsi(this.text, Math.max(1, width - this.paddingLeft)).map((line) => pad + line);
	}
	invalidate(): void {}
	handleInput(_data: string): void {}
}

export class Container implements Component {
	private readonly children: Component[] = [];
	addChild(child: Component): void {
		this.children.push(child);
	}
	render(width: number): string[] {
		return this.children.flatMap((c) => c.render(width));
	}
	invalidate(): void {
		for (const c of this.children) c.invalidate();
	}
	handleInput(_data: string): void {}
}

export class Markdown extends Text {}
export function isKeyRelease(_data: string): boolean { return false; }
export function isKeyRepeat(_data: string): boolean { return false; }

export const Key = {
	space: "space",
	escape: "escape",
	esc: "esc",
	enter: "enter",
	tab: "tab",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	shift: (key: string) => `shift+${key}`,
	ctrl: (key: string) => `ctrl+${key}`,
} as const;

const SEQUENCES: Record<string, string> = {
	" ": "space",
	"\x1d": "ctrl+]",
	"\t": "tab",
	"\x1b[Z": "shift+tab",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\r": "enter",
	"\n": "enter",
	"\x1b": "escape",
};

export function matchesKey(data: string, keyId: string): boolean {
	return SEQUENCES[data] === keyId || (data.length === 1 && data === keyId);
}
