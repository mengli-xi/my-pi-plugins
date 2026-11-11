/** Slot grammar shared by the command-independent Main and Subagent first frames. */
export const CHILD_INITIAL_LINES = ["[[pi:slot:path-short]] │ [[pi:slot:model]] [[pi:slot:effort]]"] as const;

/** Main normally occupies two rows; contributions may add a third. */
export const MAIN_INITIAL_LINES = [
  `${CHILD_INITIAL_LINES[0]} [[pi:slot:fast]]`,
  "[[pi:slot:cache-quality]]",
] as const;

/** Composed only for the fallback frame, and hidden while it has no content. */
export const MAIN_INITIAL_CONTRIBUTION_LINE = "[[pi:slot:todo]]";
