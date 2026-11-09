export const TURN_ICON = "󰄉";

const VERBS = [
  "Reasoning",
  "Analyzing",
  "Resolving",
  "Inferring",
  "Rendering",
  "Iterating",
  "Threading",
  "Distilling",
  "Razonando",
  "Pensando.",
  "Tejiendo.",
  "Afinando.",
  "Analysant",
  "Composant",
  "Éclairant",
  "Tissant..",
  "Ragionare",
  "Denkend..",
  "Cogitans.",
] as const;

export function workingLabel(text: string): string {
  return `${text.replace(/(?:…|\.{1,3})+$/u, "")}...`;
}

export function pickVerb(previous?: string): string {
  for (let index = 0; index < 8; index++) {
    const verb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
    if (verb !== previous) return verb;
  }
  return VERBS[0];
}
