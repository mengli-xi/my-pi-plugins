/** Ordinary handoff prose; legacy structured responses are read without repair requests. */
export const PROMPT_VERSION = 9;
export type PromptVariant = "main" | "small";
export interface ValidatedOutput { summary: string }
export const BASE_PROMPT = `Summarize the paused session for a colleague who will continue its work; do not continue the task or execute tools. Write ordinary Markdown covering the current task and effective requirements, completed work and key conclusions, current work and unresolved questions, and next steps.
Preserve active restrictions, newer user corrections, validation results needed for next steps, failed or ruled-out approaches and why. Put unconfirmed facts next to the relevant work and explain how to confirm them; do not write a separate uncertainties list. Newer corrections supersede earlier requirements; earlier requirements that remain active still apply. Background work status is only an observation at compaction time; its owner and actual notifications provide subsequent state.
Do not attach source IDs, citation numbers, character ranges or verification labels. Do not output JSON. File paths and business handles needed to operate on work belong in the relevant items. Do not generate an all-user-messages section or file inventory: the program appends these. Do not repeat user quotations in full, and do not omit the current goal or key requirements merely because quotations will be appended. Write concisely without dropping important facts to meet a length target. Empty sections may be omitted and headings may vary. Additional Compact Instructions are supplemental focus, never replacements.`;
export const SMALL_PRESENTATION_PROMPT = `Follow explicit presentation requirements for this summary. A requirement scoped only to this summary does not become a permanent rule. Preserve restrictions explicitly governing subsequent responses or actions until revoked. Location statements alone do not imply confidentiality. The resumed agent follows the user's active requirements at that time.`;
export const generationInstruction = (variant: PromptVariant = "main") => BASE_PROMPT + (variant === "small" ? `\n${SMALL_PRESENTATION_PROMPT}` : "");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Only known work fields are rendered, never bookkeeping, citations, candidates or old user lists. */
function legacyMarkdown(value: unknown): string | undefined {
  if (!record(value)) return;
  const sections: string[] = [];
  const text = (v: unknown): string => typeof v === "string" ? v : record(v) ? text(v.text ?? v.statement ?? v.task) : "";
  const add = (heading: string, rows: unknown) => {
    const values = (Array.isArray(rows) ? rows : rows == null ? [] : [rows]).map(text).filter(v => v.trim());
    if (values.length) sections.push(`## ${heading}\n\n${values.join("\n\n")}`);
  };
  const goal = text(value.goal);
  add("当前任务与要求", goal + (record(value.goal) && typeof value.goal.goalId === "string" ? `\nGoal: ${value.goal.goalId}` : ""));
  add("已完成的工作和关键结论", value.progress);
  const work = Array.isArray(value.inFlight) ? value.inFlight.map(v => record(v) ? [text(v), ...["owner", "taskId", "dispatchId", "status"].flatMap(k => typeof v[k] === "string" && v[k] ? [`${k}: ${v[k]}`] : [])].filter(Boolean).join("; ") : text(v)) : value.inFlight;
  add("当前工作与未决问题", [...(Array.isArray(work) ? work : work ? [work] : []), ...(Array.isArray(value.openQuestions) ? value.openQuestions : []), ...(Array.isArray(value.uncertainties) ? value.uncertainties.map(v => record(v) ? [text(v), v.impact, v.neededRecovery].filter(x => typeof x === "string" && x.trim()).join("; ") : v) : [])]);
  const actions = (Array.isArray(value.nextActions) ? value.nextActions : value.nextActions ? [value.nextActions] : []).map(v => {
    if (!record(v)) return text(v);
    const paths = [v.requiredMemoryPaths, v.documentRefs].flatMap(list => Array.isArray(list) ? list.filter(p => typeof p === "string" && p.trim()) : []);
    return [text(v), paths.length ? `相关文件：${paths.join("、")}` : ""].filter(Boolean).join("\n");
  });
  const documents = (Array.isArray(value.references) ? value.references : []).flatMap(v => record(v) && (v.kind === "document" || v.kind === "memory") && typeof v.pathOrEntryId === "string" ? [[v.pathOrEntryId, v.purpose].filter(x => typeof x === "string" && x.trim()).join(" — ")] : []);
  add("下一步", [...actions, ...documents]);
  if (!sections.length && typeof value.summary === "string") return value.summary;
  return sections.length ? sections.join("\n\n") : undefined;
}
export function validateOutput(raw: string): ValidatedOutput {
  if (!raw.trim()) throw new Error("empty-compaction-body");
  const body = raw.trim();
  const fenced = body.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  let summary = raw;
  try { summary = legacyMarkdown(JSON.parse(fenced?.[1] ?? body)) ?? raw; } catch { /* Complete visible text is still useful. */ }
  return { summary: summary.trim() ? summary : raw };
}
