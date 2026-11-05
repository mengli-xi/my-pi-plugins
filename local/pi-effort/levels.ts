/**
 * The effort ladder, and everything about it that can be decided without a
 * running pi: which rungs a model actually offers, and how a typed argument
 * (`/effort hi`, `/effort 3`, `/effort none`) resolves to one of them.
 *
 * pi calls this knob the "thinking level"; Claude Code calls it reasoning
 * effort. They are the same setting, and this package speaks the Claude Code
 * name because that is the command people are reaching for.
 */

/** Mirrors pi's `ThinkingLevel`, declared here so this file stays dependency-free. */
export type PiLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What the picker offers. `ultra` is this package's own rung, not one of pi's:
 * pi's `ThinkingLevel` is a closed union, so ultra pins the model's top real
 * level and adds a prompt fragment on top (see ultra.ts). Keeping the two types
 * apart is what stops `ultra` from being handed to `setThinkingLevel`.
 */
export type EffortLevel = PiLevel | "ultra";

/** The rungs pi itself accepts, cheapest first. */
export const PI_LEVELS: readonly PiLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Cheapest to most expensive. The order the picker lists them in. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [...PI_LEVELS, "ultra"];

/**
 * Description column. Token figures are pi's own budgets for the level (see
 * its thinking selector), so what the picker promises matches what pi sends.
 */
export const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  off: "No reasoning — fastest replies",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-deep reasoning (~32k tokens)",
  max: "Maximum reasoning the model allows",
  ultra: "Top reasoning plus proactive sub-agent delegation",
};

/** Theme colors pi already ships per level, so the picker matches the footer. */
export const EFFORT_COLORS = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
  // pi ships no ultra tone; it rides on max's so themes stay in charge.
  ultra: "thinkingMax",
} as const;

/**
 * Fallback ramp, used when the active theme paints every thinking level the
 * same colour — some do, and then the slider has no way to show that the level
 * under the caret changed. It climbs cool to hot the way the track reads
 * left to right, with 256-colour codes for terminals that want them.
 */
export const EFFORT_PALETTE: Record<EffortLevel, { rgb: [number, number, number]; ansi256: number }> = {
  off: { rgb: [138, 143, 152], ansi256: 245 },
  minimal: { rgb: [135, 175, 215], ansi256: 110 },
  low: { rgb: [95, 175, 175], ansi256: 73 },
  medium: { rgb: [135, 215, 135], ansi256: 114 },
  high: { rgb: [215, 175, 95], ansi256: 179 },
  xhigh: { rgb: [255, 135, 95], ansi256: 209 },
  max: { rgb: [215, 135, 255], ansi256: 177 },
  ultra: { rgb: [255, 95, 215], ansi256: 206 },
};

/** Just enough of a pi-ai `Model` to decide which levels it offers. */
export interface ModelLike {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<EffortLevel, unknown>>;
}

/**
 * Which levels the model actually supports, following pi's own rule: a `null`
 * entry in `thinkingLevelMap` marks a level unsupported, and the two top rungs
 * only exist for models that map them explicitly. Without a model we cannot
 * know, so the full ladder is offered and pi clamps on apply.
 */
export function supportedLevels(model: ModelLike | undefined): EffortLevel[] {
  if (!model) return [...EFFORT_LEVELS];
  if (!model.reasoning) return ["off"];

  const real = PI_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  // ultra rides on whatever the model's top rung is — it does not require
  // `max`, so every reasoning model can offer it.
  return topPiLevel(real) === undefined ? real : [...real, "ultra"];
}

/**
 * The level ultra pins underneath itself: the most expensive real rung the
 * model offers. `off` is not a reasoning level, so a model that offers only
 * `off` has no ultra.
 */
export function topPiLevel(levels: readonly EffortLevel[]): PiLevel | undefined {
  for (let index = PI_LEVELS.length - 1; index >= 0; index--) {
    const level = PI_LEVELS[index] as PiLevel;
    if (level !== "off" && levels.includes(level)) return level;
  }
  return undefined;
}

/**
 * Spellings worth accepting beyond the level names themselves. Prefixes are
 * handled separately, so this only covers words that are not prefixes of a
 * level ("none" for off, "maximum" for max).
 */
const ALIASES: Record<string, EffortLevel> = {
  none: "off",
  no: "off",
  disable: "off",
  disabled: "off",
  mid: "medium",
  "x-high": "xhigh",
  extra: "xhigh",
  maximum: "max",
  full: "max",
};

export type LevelMatch = { ok: true; level: EffortLevel } | { ok: false; message: string };

/**
 * Resolve a `/effort <arg>` argument against the levels this model offers.
 * Accepts the level name, any unambiguous prefix of it, a 1-based position in
 * the list (what the picker's number keys select), or one of the aliases.
 */
export function matchLevel(input: string, available: readonly EffortLevel[]): LevelMatch {
  const query = input.trim().toLowerCase();
  const list = available.join(", ");

  if (query === "") return { ok: false, message: `Pick a reasoning effort: ${list}` };

  if (/^\d+$/.test(query)) {
    const level = available[Number(query) - 1];
    if (level) return { ok: true, level };
    return { ok: false, message: `No effort #${query}. Available: ${list}` };
  }

  const named = available.find((level) => level === query) ?? ALIASES[query];
  if (named && available.includes(named)) return { ok: true, level: named };

  const prefixed = available.filter((level) => level.startsWith(query));
  if (prefixed.length === 1) return { ok: true, level: prefixed[0] as EffortLevel };
  if (prefixed.length > 1) {
    return { ok: false, message: `"${query}" is ambiguous: ${prefixed.join(", ")}` };
  }

  // A real level the current model does not offer is worth saying out loud;
  // pi would otherwise clamp it to a neighbour without explanation.
  const known = (EFFORT_LEVELS as readonly string[]).includes(query) || named !== undefined;
  if (known) return { ok: false, message: `This model does not offer "${query}". Available: ${list}` };

  return { ok: false, message: `Unknown reasoning effort "${query}". Available: ${list}` };
}
