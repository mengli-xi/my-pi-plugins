import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LEFT_RULE_WIDTH = 2;
const TRAILING_RULE = " ──";

export type PanelRuleTone = "accent" | "muted";

/** A panel rule whose first fitting label is embedded at the right edge. */
export function panelRightRule(
	theme: Pick<Theme, "fg">,
	width: number,
	candidates: readonly string[],
	tone: PanelRuleTone,
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const fixedWidth = LEFT_RULE_WIDTH + 1 + visibleWidth(TRAILING_RULE);
	const fitting = candidates.find((candidate) =>
		visibleWidth(candidate) + fixedWidth <= safeWidth
	);
	const fallback = candidates.at(-1) ?? "";
	const maxLabelWidth = Math.max(0, safeWidth - fixedWidth);
	const labelText = fitting ?? truncateToWidth(fallback, maxLabelWidth, "…", true);
	if (!labelText) return theme.fg(tone, "─".repeat(safeWidth));
	const label = ` ${labelText}${TRAILING_RULE}`;
	return theme.fg(
		tone,
		`${"─".repeat(Math.max(LEFT_RULE_WIDTH, safeWidth - visibleWidth(label)))}${label}`,
	);
}

/** Shared panel footer: a right-aligned shortcut label with rule spacing on both sides. */
export function panelFooterRule(
	theme: Pick<Theme, "fg">,
	width: number,
	candidates: readonly string[],
): string {
	return panelRightRule(theme, width, candidates, "muted");
}
