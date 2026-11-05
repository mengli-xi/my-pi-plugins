import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
/**
 * level-slider — a Claude Code-style slider for an ordered setting.
 *
 * Extracted from pi-effort's picker: a track running between two end labels,
 * every level marked along it, and a caret you nudge left and right until you
 * like where it sits. Levels, captions, and colours all arrive as choices, so
 * the same component can pick a thinking level, a verbosity, or any other
 * ordered ladder.
 *
 * The layout is computed per frame from the viewport width (see `layoutSlider`)
 * rather than built once, because the panel has to survive a resize while it is
 * open, and because how much room the labels get decides how far apart they can
 * stand.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { EditorPositionMouseBoundary } from "./panel-mouse.ts";
import { panelFooterRule } from "./panel-footer.ts";

const MARKER = "▲";

/** Space to try between labels, widest first. Below the last one the slider does not fit. */
const GAPS = [8, 6, 4, 2, 1];

export interface SliderLayout {
	/** Column each label starts at. */
	labelStarts: number[];
	/** Column the caret sits on for each level — the middle of its label. */
	ticks: number[];
	/** The track runs the width of the labels, first character to last. */
	trackStart: number;
	trackEnd: number;
}

/**
 * Space the labels evenly across `width`, centred as a block, and report where
 * each one starts and where its caret belongs. Undefined when even a
 * single-space gap would not fit, which the caller renders around.
 */
export function layoutSlider(labels: string[], width: number): SliderLayout | undefined {
	if (labels.length === 0) return undefined;

	const widths = labels.map((label) => visibleWidth(label));
	const cell = Math.max(...widths);

	for (const gap of GAPS) {
		const block = (cell + gap) * labels.length - gap;
		if (block + 2 > width) continue;

		const left = Math.floor((width - block) / 2);
		const labelStarts = widths.map(
			(labelWidth, index) => left + index * (cell + gap) + Math.floor((cell - labelWidth) / 2),
		);
		const ticks = labelStarts.map((start, index) => start + Math.floor(((widths[index] ?? 1) - 1) / 2));
		const lastStart = labelStarts[labelStarts.length - 1] ?? left;
		const lastWidth = widths[widths.length - 1] ?? 1;
		return {
			labelStarts,
			ticks,
			trackStart: labelStarts[0] ?? left,
			trackEnd: lastStart + lastWidth - 1,
		};
	}

	return undefined;
}

export interface LevelChoice<Value extends string = string> {
	value: Value;
	/** Caption under the track while this level is highlighted. */
	description?: string;
	/** Theme colour name — used only when every choice on offer gets its own. */
	themeColor?: string;
	/** Fallback ramp colour for themes that paint every level the same. */
	rgb?: [number, number, number];
	ansi256?: number;
}

export type LevelPainter<Value extends string = string> = (value: Value, text: string) => string;

/**
 * How the caret and the level under it get their colour.
 *
 * Theme colours are used only when every level on offer gets its own — a theme
 * is free to point several levels at the same value, and then sliding shows no
 * change at all. The per-choice ramp fills in otherwise; a choice without one
 * stays uncoloured. Half a gradient is worse than none.
 */
export function levelPainter<Value extends string>(
	theme: Theme,
	choices: readonly LevelChoice<Value>[],
): LevelPainter<Value> {
	const byValue = new Map(choices.map((choice) => [choice.value, choice]));
	const distinct = new Set<string>();
	try {
		for (const choice of choices) {
			if (!choice.themeColor) throw new Error("no theme colour");
			distinct.add(theme.getFgAnsi(choice.themeColor as never));
		}
	} catch {
		distinct.clear();
	}

	if (choices.length > 1 && distinct.size === choices.length) {
		return (value, text) => theme.fg(byValue.get(value)?.themeColor as never, text);
	}

	let truecolor = true;
	try {
		truecolor = theme.getColorMode() === "truecolor";
	} catch {
		truecolor = true;
	}

	return (value, text) => {
		const choice = byValue.get(value);
		if (!choice?.rgb && choice?.ansi256 === undefined) return text;
		const code = truecolor && choice.rgb
			? `38;2;${choice.rgb[0]};${choice.rgb[1]};${choice.rgb[2]}`
			: `38;5;${choice.ansi256 ?? 250}`;
		// Reset the foreground only, the way Theme.fg does, so a colour set
		// around this text survives it.
		return `\x1b[${code}m${text}\x1b[39m`;
	};
}

interface Piece {
	/** Where the piece wants to start, in visible columns. */
	column: number;
	text: string;
}

/**
 * Lay pieces out on one row by visible column. Text is coloured by the time it
 * gets here, so positions are measured with `visibleWidth` rather than
 * `length`; a piece that no longer fits — because the panel is narrow or an
 * earlier piece ran long — is dropped rather than allowed to shift the rest.
 */
function row(pieces: Piece[], width: number): string {
	let out = "";
	let cursor = 0;

	for (const piece of [...pieces].sort((a, b) => a.column - b.column)) {
		const pieceWidth = visibleWidth(piece.text);
		const start = Math.min(Math.max(piece.column, 0), width - pieceWidth);
		if (start < cursor) continue;
		out += " ".repeat(start - cursor) + piece.text;
		cursor = start + pieceWidth;
	}

	return out;
}

export interface LevelSliderOptions<Value extends string = string> {
	/** Panel heading. */
	title: string;
	/** End labels for the track; the ends the slider runs between. */
	leftEnd?: string;
	rightEnd?: string;
	/** Levels this slider offers, cheapest first. */
	choices: readonly LevelChoice<Value>[];
	/** The level in effect right now — where the caret starts. */
	current: Value;
	onSelect: (value: Value) => void;
	onCancel: () => void;
	/**
	 * The caret moved onto a choice. Called once on construction with the
	 * starting choice and again after every move, so a consumer can react to
	 * what is highlighted without duplicating the navigation logic. Purely
	 * observational: the slider does not care what the consumer does with it.
	 */
	onHighlight?: (value: Value) => void;
}

export class LevelSlider<Value extends string = string> implements Component {
	readonly wantsMouse = true;
	private readonly tui: TUI;
	private readonly mouseBoundary: EditorPositionMouseBoundary;
	private readonly theme: Theme;
	private readonly options: LevelSliderOptions<Value>;
	private readonly paint: LevelPainter<Value>;
	private index: number;

	constructor(tui: TUI, theme: Theme, options: LevelSliderOptions<Value>) {
		this.tui = tui;
		this.mouseBoundary = new EditorPositionMouseBoundary(tui);
		this.theme = theme;
		this.options = options;
		this.paint = levelPainter(theme, options.choices);
		this.index = Math.max(
			0,
			options.choices.findIndex((choice) => choice.value === options.current),
		);
	}

	setScreenOrigin(row: number, column: number): void {
		this.mouseBoundary.setScreenOrigin(row, column);
	}

	invalidate(): void {
		this.options.onHighlight?.(
			(this.options.choices[this.index] as LevelChoice<Value>).value,
		);

		// All geometry is derived from the current render width.
	}

	render(width: number): string[] {
		const theme = this.theme;
		const choice = this.options.choices[this.index] as LevelChoice<Value>;
		const safeWidth = Math.max(1, width);
		const layout = layoutSlider(this.options.choices.map(({ value }) => value), safeWidth);
		const titleLabel = truncateToWidth(` ${this.options.title} `, Math.max(1, safeWidth - 4), "…");
		const titleFill = "─".repeat(Math.max(0, safeWidth - 2 - visibleWidth(titleLabel)));
		const titleRule = `${theme.fg("accent", "──")}${
			theme.fg("accent", theme.bold(titleLabel))
		}${theme.fg("accent", titleFill)}`;

		const lines = [
			titleRule,
			"",
			...(layout ? this.slider(layout, safeWidth) : this.compact(safeWidth)),
			this.caption(choice.description ?? "", layout, safeWidth),
			"",
			panelFooterRule(theme, safeWidth, [
				"←/→ adjust · Enter confirm · Esc cancel",
				"←/→ adjust · Enter · Esc",
				"←/→ · Enter · Esc",
				"Esc cancel",
			]),
		];
		this.mouseBoundary.setFrame(safeWidth, lines.length);
		return lines;
	}

	/** The three rows that make up the slider proper: ends, track, labels. */
	private slider(layout: SliderLayout, width: number): string[] {
		const theme = this.theme;
		const value = (this.options.choices[this.index] as LevelChoice<Value>).value;
		const { trackStart, trackEnd } = layout;
		const caret = layout.ticks[this.index] ?? trackStart;
		const leftEnd = this.options.leftEnd ?? "Faster";
		const rightEnd = this.options.rightEnd ?? "Smarter";

		const ends: Piece[] = [{ column: trackStart, text: theme.fg("muted", leftEnd) }];
		const rightAt = trackEnd - rightEnd.length + 1;
		// Only when the two would not collide; on a narrow panel the track speaks
		// for itself and a mangled "FasterSmarter" does not.
		if (rightAt >= trackStart + leftEnd.length + 1) {
			ends.push({ column: rightAt, text: theme.fg("muted", rightEnd) });
		}

		// The track fills up to the caret in the level's colour and stays neutral
		// past it, so the colour reads as "how far along" and not just decoration.
		const track =
			this.paint(value, "─".repeat(Math.max(0, caret - trackStart)) + MARKER) +
			theme.fg("border", "─".repeat(Math.max(0, trackEnd - caret)));

		const labels = this.options.choices.map((candidate, index) => ({
			column: layout.labelStarts[index] ?? 0,
			text:
				index === this.index
					? theme.bold(this.paint(candidate.value, candidate.value))
					: theme.fg("muted", candidate.value),
		}));

		return [row(ends, width), row([{ column: trackStart, text: track }], width), row(labels, width)];
	}

	/** Too narrow for a track: keep the caret and the level, drop the scenery. */
	private compact(width: number): string[] {
		const theme = this.theme;
		const value = (this.options.choices[this.index] as LevelChoice<Value>).value;
		const left = this.index > 0 ? "◀" : " ";
		const right = this.index < this.options.choices.length - 1 ? "▶" : " ";
		const text = `${theme.fg("dim", left)} ${theme.bold(this.paint(value, value))} ${theme.fg("dim", right)}`;
		const column = Math.floor((width - (value.length + 4)) / 2);

		return ["", row([{ column, text }], width), ""];
	}

	/**
	 * What the highlighted level costs you, centred under its label — but kept
	 * within the track, so a caption at either end reads as belonging to the
	 * label above it rather than drifting off towards the panel edge.
	 */
	private caption(text: string, layout: SliderLayout | undefined, width: number): string {
		// truncateToWidth adds a reset when it cuts, so measure what is visible.
		const clipped = truncateToWidth(text, Math.max(0, width - 2), "…");
		const clippedWidth = visibleWidth(clipped);
		const tick = layout?.ticks[this.index] ?? Math.floor(width / 2);
		const wanted = tick - Math.floor(clippedWidth / 2);
		const column = layout
			? Math.min(
					Math.max(wanted, layout.trackStart),
					Math.max(layout.trackStart, layout.trackEnd - clippedWidth + 1),
				)
			: wanted;

		return row([{ column, text: this.theme.fg("text", clipped) }], width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.mouseBoundary.handleMouse(event, this.options.onCancel)) return { handled: true, render: true };
		return { handled: true, render: false };
	}

	handleInput(data: string): void {

		const keybindings = getKeybindings();

		if (keybindings.matches(data, "tui.select.confirm")) {
			this.options.onSelect((this.options.choices[this.index] as LevelChoice<Value>).value);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}

		// A slider clamps at its ends rather than wrapping: sliding past the top
		// and landing on the bottom is not what anyone means by nudging it up.
		const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : undefined;
		if (digit !== undefined && digit < this.options.choices.length) this.index = digit;
		else if (matchesKey(data, "left") || matchesKey(data, "down") || data === "h" || data === "j") {
			this.index = Math.max(0, this.index - 1);
		} else if (matchesKey(data, "right") || matchesKey(data, "up") || data === "l" || data === "k") {
			this.index = Math.min(this.options.choices.length - 1, this.index + 1);
		} else if (matchesKey(data, "home")) this.index = 0;
		else if (matchesKey(data, "end")) this.index = this.options.choices.length - 1;
		else return;

		this.options.onHighlight?.(
			(this.options.choices[this.index] as LevelChoice<Value>).value,
		);
		this.tui.requestRender();
	}

	dispose(): void {
		this.mouseBoundary.dispose();
	}
}
