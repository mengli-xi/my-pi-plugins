/** Slot grammar shared by the command-independent Main and Subagent first frames. */
export const CHILD_INITIAL_LINES = ["[[pi:slot:path-short]] │ [[pi:slot:model]] [[pi:slot:effort]]"] as const;

/** Preserve the usual row targets for CP/MEM/cache and row-three contributors. */
export const MAIN_INITIAL_LINES = [
  `${CHILD_INITIAL_LINES[0]} [[pi:slot:fast]]`,
  "[[pi:slot:cache-quality]]",
  "[[pi:slot:todo]]",
] as const;
