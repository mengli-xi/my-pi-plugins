import type { AgentId, AgentTreeNode, ConversationCaller, ResolvedTarget } from "./types.js";
import { isDomainId } from "./ids.js";

const encoder = new TextEncoder();
const TASK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const ROOT_PATH = "/root" as const;

export interface TargetResolutionOptions {
  readonly allowRoot?: boolean;
  readonly directChildOnly?: boolean;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function validateTaskName(value: unknown): string {
  if (typeof value !== "string") throw new Error("task name must be a string");
  if (value.normalize("NFC") !== value) throw new Error("task name must be NFC normalized");
  const bytes = byteLength(value);
  if (bytes < 1 || bytes > 64 || !TASK_NAME_PATTERN.test(value)) {
    throw new Error("task name must be 1..64 UTF-8 bytes and match [A-Za-z0-9][A-Za-z0-9._-]*");
  }
  return value;
}

export function validateTargetText(value: unknown): string {
  if (typeof value !== "string") throw new Error("target must be a string");
  if (value.normalize("NFC") !== value) throw new Error("target must be NFC normalized");
  const bytes = byteLength(value);
  if (bytes < 1 || bytes > 512 || CONTROL_PATTERN.test(value)) {
    throw new Error("target must be 1..512 UTF-8 bytes without controls");
  }
  return value;
}

export function taskPath(parentPath: string, taskName: string): string {
  const parent = validateCanonicalTaskPath(parentPath, true);
  const segment = validateTaskName(taskName);
  if (parent.split("/").length - 2 >= 2) throw new Error("task path depth exceeds 2");
  return `${parent}/${segment}`;
}

export function validateCanonicalTaskPath(value: unknown, allowRoot = false): string {
  const path = validateTargetText(value);
  if (!path.startsWith("/")) throw new Error("canonical task path must be absolute");
  if (path === ROOT_PATH) {
    if (!allowRoot) throw new Error("root is not an agent path");
    return path;
  }
  const segments = path.split("/").slice(1);
  if (segments[0] !== "root" || segments.length < 2 || segments.length > 3) {
    throw new Error("canonical task path must be /root/<name>[/<name>]");
  }
  for (const segment of segments.slice(1)) validateTaskName(segment);
  return path;
}

function callerPath(caller: ConversationCaller, byId: ReadonlyMap<AgentId, AgentTreeNode>): string {
  if (caller.kind === "main") return ROOT_PATH;
  const node = byId.get(caller.agentId);
  if (!node) throw new Error("caller agent is not in this tree");
  return node.taskPath;
}

function parentIdentity(caller: ConversationCaller): AgentId | undefined {
  return caller.kind === "agent" ? caller.agentId : undefined;
}

function relativeCandidates(
  target: string,
  caller: ConversationCaller,
  nodes: readonly AgentTreeNode[],
  byId: ReadonlyMap<AgentId, AgentTreeNode>,
): AgentTreeNode[] {
  const base = callerPath(caller, byId);
  if (target === "." || target === "./") {
    if (caller.kind === "main") return [];
    const self = byId.get(caller.agentId);
    return self ? [self] : [];
  }
  const cleaned = target.startsWith("./") ? target.slice(2) : target;
  if (cleaned.length === 0 || cleaned.startsWith("/") || cleaned.includes("..")) return [];
  const exactRelativePath = `${base}/${cleaned}`;
  return nodes.filter((node) => node.taskPath === exactRelativePath);
}

export function resolveAgentTarget(
  rawTarget: unknown,
  caller: ConversationCaller,
  nodes: readonly AgentTreeNode[],
  options: TargetResolutionOptions = {},
): ResolvedTarget {
  const target = validateTargetText(rawTarget);
  const byId = new Map<AgentId, AgentTreeNode>();
  const byPath = new Map<string, AgentTreeNode[]>();
  for (const node of nodes) {
    if (byId.has(node.agentId)) throw new Error(`duplicate agent id: ${node.agentId}`);
    byId.set(node.agentId, node);
    const bucket = byPath.get(node.taskPath) ?? [];
    bucket.push(node);
    byPath.set(node.taskPath, bucket);
  }

  if (target === ROOT_PATH || target === "root") {
    if (!options.allowRoot) throw new Error("target-root");
    return { kind: "main", taskPath: ROOT_PATH };
  }

  let candidates: AgentTreeNode[];
  if (isDomainId(target, "agt")) {
    const exact = byId.get(target as AgentId);
    candidates = exact ? [exact] : [];
  } else if (target.startsWith("/")) {
    const canonical = validateCanonicalTaskPath(target);
    candidates = byPath.get(canonical) ?? [];
  } else {
    candidates = relativeCandidates(target, caller, nodes, byId);
  }

  if (candidates.length === 0) throw new Error("not-found");
  if (candidates.length !== 1) throw new Error("invalid-target: ambiguous target");
  const agent = candidates[0]!;
  if (options.directChildOnly && agent.parentAgentId !== parentIdentity(caller)) {
    throw new Error("target-not-child");
  }
  return { kind: "agent", agent };
}
