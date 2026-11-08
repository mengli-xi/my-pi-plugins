import type { ResolvedAgentRoleV1 } from "../roles/types.js";
import { sha256Hex } from "./canonical.js";

const BASELINE = `You are an expert coding assistant running as a persistent background Subagent inside pi. Complete the admitted task within the capabilities listed below.

Available tools:
{{TOOLS}}

Guidelines:
{{GUIDELINES}}`;

export const CHILD_PROTOCOL_TEXT = "You are a persistent background Subagent owned by another Pi conversation. Complete only the admitted task. Collaboration tools address the same Main-owned Agent tree; wait_agents is a non-polling direct-child barrier and must be the only tool call in its assistant message, after which your turn ends until the children settle. Children you spawn get at most the tools you have (a child never gains bash or git if you lack them), and Agents at depth 2 cannot spawn at all: if your own tools cannot do the job, finish_task with blocked and say what is needed instead of delegating. send_input steers an open descendant current Task, wakes a waiting Task, or starts a new Task when idle. Only Main can close or resume agents; report completion with a normal final reply or finish_task. Interactive UI and approval are unavailable: use finish_task with blocked when a user decision is required; when the task is done, reply normally without finish_task. The workspace is shared and has no write coordinator. Do not change model, settings, authentication, session identity, or runtime capabilities.";

const FIXED_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
] as const;

export interface ChildPromptToolV1 {
  readonly name: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines: readonly string[];
}

export interface ChildPromptContextFileV1 {
  readonly path: string;
  readonly content: string;
}

export interface ChildPromptInputV1 {
  readonly customPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly contextFiles?: readonly ChildPromptContextFileV1[];
  readonly cwd: string;
  readonly tools: readonly ChildPromptToolV1[];
  readonly role: ResolvedAgentRoleV1;
  readonly skillSha256: string;
  /** 这个 child 在 Agent 树里的深度（direct child of Main 是 1）；给出后提示词会写明能否再 spawn。 */
  readonly depth?: number;
  readonly canSpawn?: boolean;
}

export interface AssembledChildPromptV1 {
  readonly version: 1;
  readonly content: string;
  readonly bytes: number;
  readonly sha256: string;
}

function lf(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function xml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character] ?? character);
}

function normalizedCwd(value: string): string {
  const normalized = lf(value).replace(/\\/gu, "/");
  if (!normalized || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new Error("cwd is invalid");
  return normalized;
}

function normalizeSingleLine(value: string, label: string): string {
  const normalized = lf(value).trim();
  if (!normalized || normalized.includes("\n")) throw new Error(`${label} must be one non-empty line`);
  return normalized;
}

export function assembleChildPromptV1(input: ChildPromptInputV1): AssembledChildPromptV1 {
  const sortedTools = [...input.tools].sort((left, right) => left.name.localeCompare(right.name));
  const toolLines = sortedTools
    .filter((tool) => tool.promptSnippet !== undefined)
    .map((tool) => `- ${normalizeSingleLine(tool.name, "tool name")}: ${normalizeSingleLine(tool.promptSnippet!, "tool snippet")}`);
  const guidelineSet = new Set<string>();
  for (const tool of sortedTools) {
    for (const guideline of tool.promptGuidelines) guidelineSet.add(normalizeSingleLine(guideline, "tool guideline"));
  }
  for (const guideline of FIXED_GUIDELINES) guidelineSet.add(guideline);
  const guidelineLines = [...guidelineSet].map((guideline) => `- ${guideline}`);
  let prompt = input.customPrompt === undefined
    ? BASELINE
        .replace("{{TOOLS}}", toolLines.length > 0 ? toolLines.join("\n") : "(none)")
        .replace("{{GUIDELINES}}", guidelineLines.join("\n"))
    : lf(input.customPrompt);
  if (input.appendSystemPrompt !== undefined) prompt += `\n\n${lf(input.appendSystemPrompt)}`;
  if (input.contextFiles && input.contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
    for (const file of input.contextFiles) {
      prompt += `<project_instructions path="${xml(lf(file.path))}">\n${lf(file.content)}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>";
  }
  prompt += `\nCurrent working directory: ${normalizedCwd(input.cwd)}`;
  // customPrompt 走的是 Main 的系统提示，里面没有工具清单；child 得知道自己到底有哪些工具、还能不能再 spawn，
  // 否则会像没有 bash 的 explorer 那样一层层往下委派同样做不了的事。
  const toolNames = sortedTools.map((tool) => normalizeSingleLine(tool.name, "tool name"));
  prompt += `\n\n--- pi-subagents capabilities ---\nTools available to this Subagent: ${toolNames.length > 0 ? toolNames.join(", ") : "(none)"}. Tools not listed here (for example bash or git) are unavailable to you and to any child you spawn.`;
  if (input.depth !== undefined) prompt += `\nYou are at depth ${input.depth} of the Agent tree. ${input.canSpawn === false || input.depth >= 2 ? "spawn_agent is unavailable at this depth." : "Children you spawn are at depth 2 and cannot spawn further."}`;
  prompt += `\n\n--- pi-subagents role ---\n${lf(input.role.body)}`;
  prompt += `\n\n--- pi-subagents protocol ---\n${CHILD_PROTOCOL_TEXT}`;
  prompt = `${prompt.replace(/\n+$/u, "")}\n`;
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes < 1 || bytes > 1_048_576) throw new Error("assembled child prompt exceeds 1 MiB");
  return Object.freeze({ version: 1, content: prompt, bytes, sha256: sha256Hex(prompt) });
}

export function childPromptFingerprint(prompt: AssembledChildPromptV1, skillSha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(skillSha256)) throw new Error("skill digest is invalid");
  return sha256Hex(`pi-subagents/prompt/v1\0${prompt.content}\0${skillSha256}`);
}
