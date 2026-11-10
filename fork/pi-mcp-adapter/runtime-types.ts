// Runtime grammar and contracts, without optional MCP Apps schemas.
import { createHash } from "node:crypto";
import type { UiMessageParams, UiPromptHandoff, UiModelContextUpdate, UiModelContextParams, ServerEntry, ServerProvenance, ToolPrefix, ToolSelectorCandidateIndex, ToolSelectorCandidateContext } from "./types.ts";
export type * from "./types.ts";

/** Versioned shared-event-bus channel for read-only MCP runtime snapshots. */
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export const MCP_STATUS_SNAPSHOT_VERSION = 1 as const;

/**
 * Extract prompt text from either legacy MCP UI message shapes or native AppBridge user messages.
 */
export function extractUiPromptText(params: UiMessageParams): string | undefined {
  if (params.type === "prompt" || params.prompt) {
    const prompt = params.prompt ?? String(params.message ?? "");
    return prompt || undefined;
  }

  if (params.role === "user" && Array.isArray(params.content)) {
    const text = params.content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n\n");
    return text || undefined;
  }

  return undefined;
}

/**
 * Parse a canonical named UI handoff encoded as `intent\n{json}`.
 */
export function parseUiPromptHandoff(prompt: string): UiPromptHandoff | undefined {
  const newlineIndex = prompt.indexOf("\n");
  if (newlineIndex <= 0) {
    return undefined;
  }

  const intent = prompt.slice(0, newlineIndex).trim();
  const payloadText = prompt.slice(newlineIndex + 1).trim();
  if (!intent || !payloadText) {
    return undefined;
  }

  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(intent)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return {
      intent,
      params: parsed as Record<string, unknown>,
      raw: prompt,
    };
  } catch {
    return undefined;
  }
}

export function createUiModelContextUpdate(params: UiModelContextParams, maxChars = 12_000): UiModelContextUpdate | undefined {
  const payload = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(payload).length === 0) return undefined;

  const serialized = JSON.stringify(payload);
  if (serialized.length <= maxChars) {
    return { payload, summary: serialized, truncated: false };
  }

  return {
    summary: `${serialized.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

/** Only the literal boolean `true` disables a server. */
export function isServerDisabled(definition: ServerEntry | undefined): boolean {
  return definition?.disabled === true;
}

const ENCODED_SERVER_NAMESPACE_MARKER = "_mcpns_";

const MAX_SERVER_NAMESPACE_LENGTH = 59;

export function formatServerNamespace(serverName: string): string {
  const normalized = serverName.replace(/-/g, "_");
  const safe = /^[A-Za-z0-9_]*$/.test(normalized) && !normalized.startsWith(ENCODED_SERVER_NAMESPACE_MARKER);
  const body = safe ? normalized : encodeServerNamespace(normalized);
  const namespace = safe ? body : `${ENCODED_SERVER_NAMESPACE_MARKER}${body}`;
  if (namespace.length <= MAX_SERVER_NAMESPACE_LENGTH) return namespace;
  // Hash the ASCII encoding, not the raw name: lone surrogates and U+FFFD share UTF-8 bytes.
  const digest = createHash("sha256").update(namespace, "utf8").digest("hex").slice(0, 16);
  // `_h_` cannot start an encoded body: `h` is neither `_` nor a hexadecimal digit.
  const hashPrefix = `${ENCODED_SERVER_NAMESPACE_MARKER}_h_`;
  const head = body.slice(0, MAX_SERVER_NAMESPACE_LENGTH - hashPrefix.length - digest.length - 1);
  return `${hashPrefix}${head}_${digest}`;
}

function encodeServerNamespace(name: string): string {
  return Array.from(name, character => {
    if (character === "_") return "__";
    return /^[A-Za-z0-9]$/.test(character) ? character : `_${character.codePointAt(0)!.toString(16)}_`;
  }).join("");
}

export const MCP_TOOL_APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request" as const;

/** The line `/mcp-adapter` and `doctor` show for a server's ignored settings. */
export function describeIgnoredSettings(provenance: ServerProvenance | undefined): string | undefined {
  if (!provenance?.ignoredSettings) return undefined;
  const file = provenance.ignoredSettingsSource === "opencode" ? "OpenCode" : "Pi mcp.json";
  return `Ignored ${file} settings: ${provenance.ignoredSettings.join(", ")}`;
}

/**
 * Most Executor app tools kept and registered per server. Pi rebuilds its whole tool registry on
 * every registration, so registering N tools costs O(N²). Paging stops here, and every read of a
 * cached catalog takes no more, whatever the cache holds.
 * @internal
 */
export const EXECUTOR_APP_TOOL_CAP = 1_000;

/**
 * Get server prefix based on tool prefix mode.
 */
function sanitizeServerPrefix(serverName: string, preserveProviderValid = true): string {
  const validCharacters = preserveProviderValid ? /^[A-Za-z0-9_-]$/ : /^[A-Za-z0-9]$/;
  return Array.from(serverName, char =>
    validCharacters.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`,
  ).join("");
}

export function getServerPrefix(
  serverName: string,
  mode: ToolPrefix
): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""));
    if (!short) short = "mcp";
    return short;
  }
  if (mode === "mcp") return `mcp__${sanitizeServerPrefix(serverName)}`;
  return sanitizeServerPrefix(serverName);
}

/**
 * Provider tool names are limited to 64 characters (OpenAI, Anthropic, Bedrock); one name over
 * the limit makes the provider reject the whole request.
 * @internal
 */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `name` cut to fit {@link MAX_TOOL_NAME_LENGTH} with an 8-hex hash of `hashInput` appended.
 * @internal
 */
export function hashedToolName(name: string, hashInput: string): string {
  const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * A tool name with server prefix before {@link formatToolName} fits it to the length limit.
 * @internal
 */
export function joinToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const p = getServerPrefix(serverName, prefix);
  const sanitized = toolName.replace(/\./g, "_");
  if (p && sanitized.startsWith(`${p}_`) && sanitized.length > p.length + 1) {
    return sanitized;
  }
  return p ? `${p}_${sanitized}` : sanitized;
}

function fitToolName(name: string): string {
  return name.length <= MAX_TOOL_NAME_LENGTH ? name : hashedToolName(name, name);
}

/**
 * Format a tool name with server prefix. A name over 64 characters is cut and gets a hash of the
 * full name.
 */
export function formatToolName(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix
): string {
  return fitToolName(joinToolName(toolName, serverName, prefix));
}

export function resolveToolPrefix(
  definition?: Pick<ServerEntry, "toolPrefix">,
  globalPrefix?: ToolPrefix,
): ToolPrefix {
  return definition?.toolPrefix ?? globalPrefix ?? "server";
}

/** A canonical name has an owner only when exactly one eligible entry produces it. */
export function resolveUniqueNameOwnership<T>(
  entries: readonly T[],
  getName: (entry: T) => string,
): { unique: T[]; collisions: Map<string, T[]> } {
  const owners = new Map<string, T[]>();
  for (const entry of entries) {
    const name = getName(entry);
    const named = owners.get(name) ?? [];
    named.push(entry);
    owners.set(name, named);
  }
  const collisions = new Map([...owners].filter(([, named]) => named.length > 1));
  return {
    unique: entries.filter((entry) => !collisions.has(getName(entry))),
    collisions,
  };
}

/**
 * Resolve a configured MCP server name from a prefixed tool name.
 *
 * When the proxy tool is addressed with a fully-qualified name such as
 * `searxng_searxng_web_search`, downstream policy systems (for example a
 * permission gate) need to recover the owning server so they can evaluate
 * server-scoped rules against the bare server name. This performs the inverse
 * of {@link getServerPrefix}: it finds the longest configured server prefix
 * that the tool name starts with and returns that server's name.
 *
 * @param toolName - the tool name as passed to the proxy `mcp({ tool })` call.
 * @param serverNames - the configured MCP server names (keys of `mcpServers`).
 * @param prefix - the active tool-prefix mode.
 * @returns the resolved server name, or `undefined` when no prefix matches or
 *   the prefix mode is `"none"`.
 */
export function resolveServerFromToolName(
  toolName: string,
  serverNames: Iterable<string>,
  prefix: ToolPrefix,
): string | undefined {
  if (prefix === "none") return undefined;
  // formatToolName keeps the first 55 characters of a name it cuts, so a server prefix longer than
  // that survives only as a fragment and the full-prefix test below can't see it.
  const keptLength = MAX_TOOL_NAME_LENGTH - 9;
  const isCut = toolName.length === MAX_TOOL_NAME_LENGTH && /_[0-9a-f]{8}$/.test(toolName);
  const candidates: { name: string; prefix: string }[] = [];
  const cutPrefixOwners: string[] = [];
  for (const name of serverNames) {
    const p = getServerPrefix(name, prefix);
    if (p && toolName.startsWith(p + "_")) candidates.push({ name, prefix: p });
    else if (p && isCut && p.length + 1 > keptLength && p.startsWith(toolName.slice(0, keptLength))) cutPrefixOwners.push(name);
  }
  // Fail safe like the ambiguous case below: a cut prefix can't tell its server apart from another match.
  if (cutPrefixOwners.length > 0) return candidates.length === 0 && cutPrefixOwners.length === 1 ? cutPrefixOwners[0] : undefined;
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.prefix.length - a.prefix.length);
  const best = candidates[0];
  // Fail safe: short mode can intentionally map names such as foo and foo-mcp
  // to the same prefix. Return undefined so a downstream permission gate uses
  // its existing wildcard path rather than enforcing a rule against the wrong server.
  if (candidates.some((c) => c.prefix === best!.prefix && c.name !== best!.name)) {
    return undefined;
  }
  return best?.name;
}

export function sanitizePromptName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  if (!cleaned) return "prompt";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function formatPromptCommandName(
  promptName: string,
  serverName: string,
  prefix: ToolPrefix,
): string {
  const serverPart = getServerPrefix(serverName, prefix) || sanitizeServerPrefix(serverName) || "server";
  return `mcp__${serverPart}__${sanitizePromptName(promptName)}`;
}

function getLegacyServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short") return sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""), false) || "mcp";
  if (mode === "mcp") return `mcp__${sanitizeServerPrefix(serverName, false)}`;
  return sanitizeServerPrefix(serverName, false);
}

function formatLegacyToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const serverPrefix = getLegacyServerPrefix(serverName, prefix);
  const sanitizedToolName = toolName.replace(/[.-]/g, "_");
  return serverPrefix ? `${serverPrefix}_${sanitizedToolName}` : sanitizedToolName;
}

export function getToolNameCandidates(toolName: string, serverName: string, prefix: ToolPrefix, includeLegacy = true): Set<string> {
  const candidates = new Set<string>([toolName]);
  for (const mode of [prefix, "server", "short", "mcp"] as const) {
    const joined = joinToolName(toolName, serverName, mode);
    // A name cut to fit the limit still matches a selector or call that uses its full name.
    candidates.add(joined);
    candidates.add(fitToolName(joined));
  }
  if (includeLegacy) {
    const legacyToolName = toolName.replace(/-/g, "_");
    candidates.add(legacyToolName);
    for (const mode of [prefix, "server", "short", "mcp"] as const) {
      const legacyJoined = joinToolName(legacyToolName, serverName, mode);
      const joined = joinToolName(toolName, serverName, mode);
      candidates.add(legacyJoined);
      candidates.add(fitToolName(legacyJoined));
      candidates.add(formatLegacyToolName(toolName, serverName, mode));
      candidates.add(joined.replace(/-/g, "_"));
      candidates.add(fitToolName(joined).replace(/-/g, "_"));
    }
  }
  return candidates;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function createToolSelectorCandidateIndex(
  allCurrentCandidates: Set<string>,
  additionalCurrentCandidatesByToolName?: ReadonlyMap<string, ReadonlySet<string>>,
): ToolSelectorCandidateIndex {
  return {
    allCurrentCandidates,
    matchingCountByPattern: new Map<string, number>(),
    matcherByPattern: new Map<string, RegExp>(),
    ...(additionalCurrentCandidatesByToolName ? { additionalCurrentCandidatesByToolName } : {}),
  };
}

export function matchesToolPattern(candidates: Set<string>, patterns?: unknown): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    if (!pattern.includes("*") && !pattern.includes("?") && candidates.has(pattern)) {
      return true;
    }
    if ((pattern.includes("*") || pattern.includes("?")) && [...candidates].some(candidate => globToRegExp(pattern).test(candidate))) {
      return true;
    }
  }

  return false;
}

function indexHasOtherCurrentMatch(
  index: ToolSelectorCandidateIndex,
  toolName: string,
  currentCandidates: Set<string>,
  pattern: string,
): boolean {
  const additionalCandidates = index.additionalCurrentCandidatesByToolName?.get(toolName);
  const hasCandidate = (candidate: string): boolean =>
    index.allCurrentCandidates.has(candidate) || additionalCandidates?.has(candidate) === true;
  const isGlob = pattern.includes("*") || pattern.includes("?");
  if (!isGlob) {
    return hasCandidate(pattern) && !currentCandidates.has(pattern);
  }

  let matcher = index.matcherByPattern.get(pattern);
  if (!matcher) {
    matcher = globToRegExp(pattern);
    index.matcherByPattern.set(pattern, matcher);
  }
  let matchingCount = index.matchingCountByPattern.get(pattern);
  if (matchingCount === undefined) {
    matchingCount = 0;
    for (const candidate of index.allCurrentCandidates) {
      if (matcher.test(candidate)) matchingCount++;
    }
    index.matchingCountByPattern.set(pattern, matchingCount);
  }

  let totalMatchingCount = matchingCount;
  if (additionalCandidates) {
    for (const candidate of additionalCandidates) {
      if (!index.allCurrentCandidates.has(candidate) && matcher.test(candidate)) totalMatchingCount++;
    }
  }
  if (totalMatchingCount === 0) return false;

  let currentMatchingCount = 0;
  for (const candidate of currentCandidates) {
    if (hasCandidate(candidate) && matcher.test(candidate)) currentMatchingCount++;
  }
  return totalMatchingCount > currentMatchingCount;
}

function matchesToolSelector(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  patterns: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const currentCandidates = getToolNameCandidates(toolName, serverName, prefix, false);
  if (matchesToolPattern(currentCandidates, patterns)) return true;
  if (!otherCurrentCandidates) return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), patterns);
  const legacyCandidates = getToolNameCandidates(toolName, serverName, prefix);
  for (const candidate of currentCandidates) legacyCandidates.delete(candidate);
  return patterns.some(pattern => {
    if (typeof pattern !== "string" || !matchesToolPattern(legacyCandidates, [pattern])) return false;
    const hasCollision = otherCurrentCandidates instanceof Set
      ? matchesToolPattern(otherCurrentCandidates, [pattern])
      : indexHasOtherCurrentMatch(otherCurrentCandidates, toolName, currentCandidates, pattern);
    return !hasCollision;
  });
}

export function isToolIncluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  if (!Array.isArray(includeTools) || includeTools.length === 0) return true;
  return matchesToolSelector(toolName, serverName, prefix, includeTools, otherCurrentCandidates);
}

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  excludeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  return matchesToolSelector(toolName, serverName, prefix, excludeTools, otherCurrentCandidates);
}

export function isToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  excludeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  return isToolIncluded(toolName, serverName, prefix, includeTools, otherCurrentCandidates)
    && !isToolExcluded(toolName, serverName, prefix, excludeTools, otherCurrentCandidates);
}

export function supportsOAuth(definition: ServerEntry): boolean {
  // OAuth requires a URL
  if (!definition.url) return false

  // Explicitly disabled via auth: false or oauth: false
  if (definition.auth === false) return false
  if (definition.oauth === false) return false
  if (definition.auth === "oauth") return true

  // Configured custom headers take precedence over implicit OAuth auto-detection.
  if (definition.headers && Object.keys(definition.headers).length > 0) return false

  // OAuth is enabled when auth is not specified (auto-detect)
  return definition.auth === undefined
}