/** Shared public grammar, kept separate from capture/projection for cold startup consumers. */
export type ForkTurns = "none" | "all" | `${number}`;
export const FORK_TURN_KEYWORDS = ["none", "all"] as const;
export const MAX_FORK_TURNS = 100_000;
export const FORK_TURNS_NUMERIC_PATTERN = "^(?:[1-9][0-9]{0,4}|100000)$";
export const FORK_TURNS_DESCRIPTION = `Inherited effective context: none (default), all, or 1..${MAX_FORK_TURNS} most recent complete turns. If effective-context-unavailable, use none.`;
const numeric = new RegExp(FORK_TURNS_NUMERIC_PATTERN, "u");
export function parseForkTurns(value: string): "none" | "all" | number {
  if ((FORK_TURN_KEYWORDS as readonly string[]).includes(value)) return value as "none" | "all";
  if (!numeric.test(value)) throw new Error(`fork_turns must be none, all, or canonical 1..${MAX_FORK_TURNS}`);
  return Number(value);
}
