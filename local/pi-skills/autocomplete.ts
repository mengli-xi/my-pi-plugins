import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import {
  isSkillNameCharacter,
  type BoundSkillMention,
  type SkillRef,
} from "./skills.ts";

const SKILL_COMPLETION = Symbol("pi-skills.completion");

interface SkillCompletionItem extends AutocompleteItem {
  [SKILL_COMPLETION]?: SkillRef;
}

function fullText(lines: readonly string[]): string {
  return lines.join("\n");
}

function offsetAt(lines: readonly string[], line: number, col: number): number {
  let offset = 0;
  for (let index = 0; index < line; index++) offset += (lines[index]?.length ?? 0) + 1;
  return offset + col;
}

function cursorAt(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, col: before.at(-1)?.length ?? 0 };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length++;
  return length;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length++;
  return length;
}

/**
 * Sidecar metadata for completions. Edits are rebased conservatively: a binding
 * intersecting an edited region is discarded instead of ever pointing at the
 * wrong skill. Manual `$name` resolution remains as the unambiguous fallback.
 */
export class DraftSkillBindings {
  private text = "";
  private bindings: BoundSkillMention[] = [];

  reconcile(nextText: string): void {
    if (nextText === this.text) return;
    const prefix = commonPrefixLength(this.text, nextText);
    const suffix = commonSuffixLength(this.text, nextText, prefix);
    const oldEditEnd = this.text.length - suffix;
    const newEditEnd = nextText.length - suffix;
    const delta = newEditEnd - oldEditEnd;
    this.bindings = this.bindings.flatMap((binding) => {
      if (binding.end <= prefix) return [binding];
      if (binding.start >= oldEditEnd) {
        return [{ ...binding, start: binding.start + delta, end: binding.end + delta }];
      }
      return [];
    });
    this.text = nextText;
  }

  applyCompletion(
    oldText: string,
    newText: string,
    replacedStart: number,
    replacedEnd: number,
    skill: SkillRef,
  ): void {
    this.reconcile(oldText);
    const delta = newText.length - oldText.length;
    this.bindings = this.bindings.flatMap((binding) => {
      if (binding.end <= replacedStart) return [binding];
      if (binding.start >= replacedEnd) {
        return [{ ...binding, start: binding.start + delta, end: binding.end + delta }];
      }
      return [];
    });
    const token = `$${skill.name}`;
    this.bindings.push({
      start: replacedStart,
      end: replacedStart + token.length,
      name: skill.name,
      path: skill.path,
    });
    this.bindings.sort((left, right) => left.start - right.start);
    this.text = newText;
  }

  takeForSubmission(text: string): BoundSkillMention[] {
    this.reconcile(text);
    const bindings = this.bindings.filter(
      (binding) => text.slice(binding.start, binding.end) === `$${binding.name}`,
    );
    this.text = "";
    this.bindings = [];
    return bindings;
  }

  clear(): void {
    this.text = "";
    this.bindings = [];
  }
}

export function extractSkillPrefix(textBeforeCursor: string): string | undefined {
  let start = textBeforeCursor.length - 1;
  while (start >= 0 && isSkillNameCharacter(textBeforeCursor[start])) start--;
  if (start < 0 || textBeforeCursor[start] !== "$") return undefined;
  return textBeforeCursor.slice(start);
}

function scopeLabel(skill: SkillRef): string {
  if (skill.scope === "project") return "Project skill";
  if (skill.scope === "temporary") return "Temporary skill";
  return "Global skill";
}

function completionDescription(skill: SkillRef, duplicateNames: ReadonlySet<string>): string {
  return [
    scopeLabel(skill),
    duplicateNames.has(skill.name) ? skill.path : undefined,
    skill.description,
  ].filter(Boolean).join(" · ");
}

export function createSkillAutocompleteProvider(
  current: AutocompleteProvider,
  getSkills: () => readonly SkillRef[] | Promise<readonly SkillRef[]>,
  draftBindings: DraftSkillBindings,
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "$"])],
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const prefix = extractSkillPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
      if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const query = prefix.slice(1).toLocaleLowerCase();
      const skills = [...await getSkills()];
      const nameCounts = new Map<string, number>();
      for (const skill of skills) nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
      const duplicateNames = new Set(
        [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name),
      );
      const items: SkillCompletionItem[] = fuzzyFilter(skills, query, (skill) => skill.name)
        .map((skill) => ({
          value: skill.name,
          label: skill.name,
          description: completionDescription(skill, duplicateNames),
          [SKILL_COMPLETION]: skill,
        }));
      return items.length > 0 ? { items, prefix } : current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const skill = (item as SkillCompletionItem)[SKILL_COMPLETION];
      if (!skill) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);

      const oldText = fullText(lines);
      const cursorOffset = offsetAt(lines, cursorLine, cursorCol);
      const replacedStart = cursorOffset - prefix.length;
      let replacedEnd = cursorOffset;
      while (replacedEnd < oldText.length && isSkillNameCharacter(oldText[replacedEnd])) replacedEnd++;
      const suffix = oldText.slice(replacedEnd);
      const separator = suffix.length === 0 || (!/^\s/.test(suffix) && isSkillNameCharacter(suffix[0])) ? " " : "";
      const insertion = `$${skill.name}${separator}`;
      const newText = oldText.slice(0, replacedStart) + insertion + suffix;
      draftBindings.applyCompletion(oldText, newText, replacedStart, replacedEnd, skill);
      const cursor = cursorAt(newText, replacedStart + insertion.length);
      return { lines: newText.split("\n"), cursorLine: cursor.line, cursorCol: cursor.col };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
