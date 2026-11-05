import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";

export type MouseEventKind = "press" | "release" | "drag" | "wheel";

export interface MouseEvent {
	kind: MouseEventKind;
	/** 0 left, 1 middle, 2 right. Meaningless for wheel events. */
	button: number;
	/** Zero-based screen column. */
	col: number;
	/** Zero-based screen row. */
	row: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** Wheel direction: -1 toward the top, 1 toward the bottom. */
	wheel: -1 | 0 | 1;
}

/** Keep domain view callbacks in screen coordinates; Pi owns decoding and capture. */
export function panelMouseEvent(event: TuiMouseEvent): MouseEvent | undefined {
	if (event.type === "click" || event.type === "move") return undefined;
	return {
		kind: event.type,
		button: event.button === "left" ? 0 : event.button === "middle" ? 1 : event.button === "right" ? 2 : 3,
		col: event.screenX, row: event.screenY,
		shift: event.shift, alt: event.alt, ctrl: event.ctrl,
		wheel: event.type === "wheel" ? Math.sign(event.wheelDelta ?? 0) as -1 | 0 | 1 : 0,
	};
}

const SGR_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const LEGACY_REPORT = /\x1b\[M([\s\S])([\s\S])([\s\S])/g;
const BUTTON_MASK = 0x03;
const SHIFT_FLAG = 0x04;
const ALT_FLAG = 0x08;
const CTRL_FLAG = 0x10;
const MOTION_FLAG = 0x20;
const WHEEL_FLAG = 0x40;
const LEGACY_RELEASE_BUTTON = 3;

function decode(button: number, col: number, row: number): MouseEvent | undefined {
	const base = {
		col,
		row,
		shift: (button & SHIFT_FLAG) !== 0,
		alt: (button & ALT_FLAG) !== 0,
		ctrl: (button & CTRL_FLAG) !== 0,
	};
	if (button & WHEEL_FLAG) {
		const direction = button & BUTTON_MASK;
		if (direction > 1) return undefined;
		return {
			...base,
			kind: "wheel",
			button: direction,
			wheel: direction === 1 ? 1 : -1,
		};
	}
	return {
		...base,
		kind: button & MOTION_FLAG ? "drag" : "press",
		button: button & BUTTON_MASK,
		wheel: 0,
	};
}

/** Decode every SGR or legacy mouse report in one terminal input chunk. */
export function parseMouseEvents(data: string): MouseEvent[] {
	if (!data.includes("\x1b[")) return [];
	const events: MouseEvent[] = [];
	for (const match of data.matchAll(SGR_REPORT)) {
		const button = Number(match[1]);
		const col = Number(match[2]) - 1;
		const row = Number(match[3]) - 1;
		if (match[4] === "m") {
			events.push({
				kind: "release",
				button: button & BUTTON_MASK,
				col,
				row,
				shift: (button & SHIFT_FLAG) !== 0,
				alt: (button & ALT_FLAG) !== 0,
				ctrl: (button & CTRL_FLAG) !== 0,
				wheel: 0,
			});
			continue;
		}
		const event = decode(button, col, row);
		if (event) events.push(event);
	}
	for (const match of data.matchAll(LEGACY_REPORT)) {
		const button = match[1]!.charCodeAt(0) - 32;
		const col = match[2]!.charCodeAt(0) - 33;
		const row = match[3]!.charCodeAt(0) - 33;
		if (!(button & WHEEL_FLAG) && (button & BUTTON_MASK) === LEGACY_RELEASE_BUTTON) {
			events.push({
				kind: "release",
				button: 0,
				col,
				row,
				shift: (button & SHIFT_FLAG) !== 0,
				alt: (button & ALT_FLAG) !== 0,
				ctrl: (button & CTRL_FLAG) !== 0,
				wheel: 0,
			});
			continue;
		}
		const event = decode(button, col, row);
		if (event) events.push(event);
	}
	return events;
}

/**
 * Shared lifecycle for a complete editor-position panel's mouse boundary.
 * Every mouse report is consumed; an outside left press closes exactly the
 * focused panel, so the same click can never activate content underneath it.
 */
export class EditorPositionMouseBoundary {
	private origin: { row: number; column: number } | undefined;
	private width = 0;
	private height = 0;

	constructor(_tui: TUI) {}

	setFrame(width: number, height: number): void {
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
	}

	setScreenOrigin(row: number, column: number): void {
		if (!Number.isFinite(row) || !Number.isFinite(column)) return;
		this.origin = { row: Math.floor(row), column: Math.floor(column) };
	}

	/** True only when this boundary consumed an outside click by closing. */
	handleMouse(event: TuiMouseEvent, close: () => void): boolean {
		if (event.type === "press" && event.button === "left" && this.outside(event.screenY, event.screenX)) {
			close();
			return true;
		}
		return false;
	}

	dispose(): void {}

	private outside(row: number, column: number): boolean {
		if (this.width === 0 || this.height === 0) return false;
		const origin = this.origin;
		if (!origin) return false;
		return row < origin.row || row >= origin.row + this.height
			|| column < origin.column || column >= origin.column + this.width;
	}

}
