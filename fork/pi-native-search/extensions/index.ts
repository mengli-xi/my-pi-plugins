/**
 * Pi Search Extension
 *
 * Adds web_search and web_fetch tools to pi.
 * Uses the current provider's native web search API when available
 * (ZAI, Google, OpenAI, xAI, Anthropic), falls back to DuckDuckGo otherwise.
 * ZAI search uses the Web Search Prime MCP endpoint (included in
 * Coding Plans) rather than the separate paid Web Search API.
 *
 * Usage:
 *   /search          - Toggle search tools on/off (only shows configured providers)
 *   /search providers - Show ALL providers and their capabilities
 *   /search config    - Show current config
 *   /search on|off    - Quick toggle
 *
 * Config persists in the explicitly supplied agent directory (getAgentDir by default).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
  type SelectItem,
  SelectList,
} from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { installNativeSearchChildCapability } from "./subagent-capability.ts";

import { discoverSearchBackends, type SearchBackendEvents, type SearchBackendV1 } from "./backends.ts";
export { SEARCH_BACKENDS_REQUEST_V1 } from "./backends.ts";
export type { SearchBackendEvents, SearchBackendV1 } from "./backends.ts";

import { loadSearchConfig, saveSearchConfig, type SearchConfig, type SearchBackendOverride } from "./config.ts";
export { loadSearchConfig } from "./config.ts";
export type { SearchConfig, SearchBackendOverride } from "./config.ts";

const SEARCH_COMMANDS = ["on", "off", "providers", "config"] as const;
const SEARCH_USAGE = "Usage: /search [on|off|providers|config]";
function parseSearchCommand(args: string): "" | typeof SEARCH_COMMANDS[number] | undefined {
  const sub = args.trim().toLowerCase();
  return sub === "" ? "" : SEARCH_COMMANDS.find(command => command === sub);
}

const PROVIDERS: Record<
  string,
  {
    name: string;
    nativeSearch: boolean;
    nativeFetch: boolean;
    envKey: string;
  }
> = {
  zai: {
    name: "ZAI (GLM)",
    nativeSearch: true,
    nativeFetch: true,
    envKey: "ZAI_API_KEY",
  },
  google: {
    name: "Google Gemini",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "GEMINI_API_KEY",
  },
  openai: {
    name: "OpenAI",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "OPENAI_API_KEY",
  },
  xai: {
    name: "xAI (Grok)",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "XAI_API_KEY",
  },
  anthropic: {
    name: "Anthropic",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "ANTHROPIC_API_KEY",
  },
  openrouter: {
    name: "OpenRouter",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "OPENROUTER_API_KEY",
  },
  deepseek: {
    name: "DeepSeek",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "DEEPSEEK_API_KEY",
  },
  mistral: {
    name: "Mistral",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "MISTRAL_API_KEY",
  },
  groq: {
    name: "Groq",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "GROQ_API_KEY",
  },
  cerebras: {
    name: "Cerebras",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "CEREBRAS_API_KEY",
  },
  huggingface: {
    name: "Hugging Face",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "HF_TOKEN",
  },
  fireworks: {
    name: "Fireworks",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "FIREWORKS_API_KEY",
  },
  cloudflare: {
    name: "Cloudflare",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  "amazon-bedrock": {
    name: "Amazon Bedrock",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  "azure-openai": {
    name: "Azure OpenAI",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  kimi: {
    name: "Kimi",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "KIMI_API_KEY",
  },
  minimax: {
    name: "MiniMax",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "MINIMAX_API_KEY",
  },
  "github-copilot": {
    name: "GitHub Copilot",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  vercel: {
    name: "Vercel AI Gateway",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "AI_GATEWAY_API_KEY",
  },
  opencode: {
    name: "OpenCode",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "OPENCODE_API_KEY",
  },
};

// ─── Credential status ────────────────────────────────────────────────────────

/** Pi owns API-key, OAuth, command-backed, and provider-config credentials. */
function hasCredentials(ctx: ExtensionContext, provider: string): boolean {
  if (!PROVIDERS[provider]) return false;
  try {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    return status.configured || status.source !== undefined;
  } catch {
    return false;
  }
}

function nativeCredentialCompatible(
  provider: string,
  credential: string | undefined,
): boolean {
  // Match Pi 0.85.1's effective Anthropic credential classifier. Checking the
  // resolved token preserves precedence: a CLI API-key override must win over
  // stored OAuth, while an OAuth token must never be sent as x-api-key.
  return provider !== "anthropic" || !credential?.includes("sk-ant-oat");
}

// ─── ZAI MCP Web Search ──────────────────────────────────────────────────────

const ZAI_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";

interface McpSession {
  sessionId: string;
}

async function mcpInit(apiKey: string, signal?: AbortSignal): Promise<McpSession> {
  const res = await fetch(ZAI_MCP_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pi-search", version: "0.1.0" },
      },
    }),
  });
  if (!res.ok)
    throw new Error(`ZAI MCP init ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const sessionId = res.headers.get("Mcp-Session-Id");
  if (!sessionId) throw new Error("ZAI MCP: no session ID returned");
  return { sessionId };
}

async function mcpCall<T = any>(
  session: McpSession,
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
  id: number,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(ZAI_MCP_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": session.sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok)
    throw new Error(
      `ZAI MCP ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const text = await res.text();
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const json = JSON.parse(line.slice(5).trim());
      if (json.error) throw new Error(`ZAI MCP: ${json.error.message}`);
      return json.result as T;
    }
  }
  throw new Error("ZAI MCP: no data in response");
}

async function zaiSearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const session = await mcpInit(apiKey, signal);
  const result = (await mcpCall(
    session,
    apiKey,
    "tools/call",
    {
      name: "web_search_prime",
      arguments: { search_query: query },
    },
    2,
    signal,
  )) as any;

  const content = result?.content?.[0]?.text;
  if (!content) return "No results found.";

  let parsed: unknown = content;
  for (let i = 0; i < 3; i++) {
    if (typeof parsed !== "string") break;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }

  if (!Array.isArray(parsed))
    return typeof parsed === "string" ? parsed : "No results found.";

  const results = parsed as {
    title: string;
    link: string;
    content: string;
    refer: string;
  }[];
  if (!results.length) return "No results found.";

  const parts: string[] = [];
  for (let i = 0; i < Math.min(results.length, 8); i++) {
    const r = results[i]!;
    parts.push(`${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.content}`);
  }
  return parts.join("\n\n");
}

// ─── Anthropic Web Search ─────────────────────────────────────────────────────

async function anthropicSearch(
  query: string,
  model: string,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/v1/messages`
    : "https://api.anthropic.com/v1/messages";
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok)
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;

  const parts: string[] = [];
  const sources: { title: string; url: string }[] = [];

  for (const block of data.content || []) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "web_search_tool_result") {
      for (const result of block.content || []) {
        if (result.type === "web_search_result") {
          sources.push({ title: result.title || "", url: result.url || "" });
        }
      }
    } else if (block.type === "text" && block.citations) {
      for (const cit of block.citations || []) {
        if (cit.type === "web_search_result_location") {
          sources.push({ title: cit.title || "", url: cit.url || "" });
        }
      }
    }
  }

  if (sources.length) {
    parts.push("\n## Sources:");
    for (const s of sources.slice(0, 8)) parts.push(`- [${s.title}](${s.url})`);
  }

  return parts.join("\n") || "No results found.";
}

// ─── Other Native Search ─────────────────────────────────────────────────────

async function googleSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    },
  );
  if (!res.ok)
    throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const parts: string[] = [];
  const c = data.candidates?.[0];
  if (c?.content?.parts?.[0]?.text) parts.push(c.content.parts[0].text);
  if (c?.groundingMetadata?.groundingChunks) {
    parts.push("\n## Sources:");
    for (const ch of c.groundingMetadata.groundingChunks.slice(0, 8))
      if (ch.web) parts.push(`- [${ch.web.title}](${ch.web.uri})`);
  }
  return parts.join("\n") || "No results found.";
}

async function openaiSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      input: query,
    }),
  });
  if (!res.ok)
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const parts: string[] = [];
  for (const item of data.output || []) {
    if (item.type === "message" && item.content?.[0]?.text) {
      parts.push(item.content[0].text);
      const urls =
        item.content[0].annotations
          ?.filter((a: any) => a.type === "url_citation")
          .map((a: any) => `- [${a.title}](${a.url})`) || [];
      if (urls.length) {
        parts.push("\n## Sources:");
        parts.push(...urls.slice(0, 8));
      }
    }
  }
  return parts.join("\n") || "No results found.";
}

async function xaiSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      input: query,
    }),
  });
  if (!res.ok)
    throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const parts: string[] = [];
  for (const item of data.output || [])
    if (item.type === "message" && item.content?.[0]?.text)
      parts.push(item.content[0].text);
  if (data.citations?.length) {
    parts.push("\n## Sources:");
    for (const c of data.citations.slice(0, 8)) parts.push(`- ${c}`);
  }
  return parts.join("\n") || "No results found.";
}

// ─── DuckDuckGo Fallback ─────────────────────────────────────────────────────

function extractDdgUrl(raw: string): string {
  const uddg = raw.match(/[?&]uddg=([^&]+)/)?.[1];
  if (uddg) {
    try {
      return decodeURIComponent(uddg);
    } catch {}
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

async function ddgSearch(query: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PiSearch/1.0)" },
    },
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  const titles: { url: string; title: string }[] = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  const tr = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = tr.exec(html)) && titles.length < 8)
    titles.push({
      url: extractDdgUrl(m[1]!),
      title: m[2]!.replace(/<[^>]+>/g, "").trim(),
    });
  const sr = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = sr.exec(html)) && snippets.length < 8)
    snippets.push(m[1]!.replace(/<[^>]+>/g, "").trim());
  const results: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    results.push(
      `${i + 1}. **${titles[i]!.title}**\n   ${titles[i]!.url}${snippets[i] ? `\n   ${snippets[i]}` : ""}`,
    );
  }
  return results.join("\n\n") || `No results found for "${query}".`;
}

// ─── Web Fetch ────────────────────────────────────────────────────────────────

async function httpFetch(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PiSearch/1.0)",
      Accept: "text/html,text/plain,application/json",
    },
  });
  if (!res.ok) throw new Error(`Fetch ${res.status} ${res.statusText}`);
  const ct = res.headers.get("content-type") || "";
  let text = ct.includes("application/json")
    ? JSON.stringify(await res.json(), null, 2)
    : await res.text();
  if (ct.includes("text/html"))
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const t = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return (
    t.content +
    (t.truncated ? `\n\n[Truncated: ${t.outputLines}/${t.totalLines} lines]` : "")
  );
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function checkedResult<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  const value = await result;
  signal?.throwIfAborted();
  return value;
}

/** Unknown backend IDs keep the provider default; discovery conflicts never select an arbitrary owner. */
function searchRoute(config: SearchConfigSnapshot, provider: string, backends: readonly SearchBackendV1[]): "native" | "ddg" | SearchBackendV1 {
  const override = config.providerOverrides[provider]?.searchBackend;
  if (override === "ddg") return "ddg";
  return backends.find(backend => backend.id === override) ??
    backends.find(backend => backend.defaultProviders.includes(provider)) ?? "native";
}

async function doSearch(
  query: string,
  provider: string,
  model: string,
  baseUrl: string,
  apiKey: string | undefined,
  useNative: boolean,
  route: "native" | "ddg" | SearchBackendV1,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ text: string; nativeError?: string }> {
  signal?.throwIfAborted();
  if (useNative) {
    try {
      if (typeof route === "object") {
        const text = await checkedResult(route.search({ query, ctx, signal }), signal);
        if (typeof text !== "string") throw new Error(`Search backend ${route.id}: invalid text result`);
        return { text };
      }
      switch (provider) {
        case "zai":
          return { text: await checkedResult(zaiSearch(query, apiKey!, signal), signal) };
        case "google":
          return { text: await checkedResult(googleSearch(query, model, apiKey!, signal), signal) };
        case "openai":
          return { text: await checkedResult(openaiSearch(query, model, apiKey!, signal), signal) };
        case "xai":
          return { text: await checkedResult(xaiSearch(query, model, apiKey!, signal), signal) };
        case "anthropic":
          return {
            text: await checkedResult(anthropicSearch(query, model, apiKey!, baseUrl, signal), signal),
          };
      }
    } catch (nativeError) {
      if (signal?.aborted) throw nativeError;
      try {
        return {
          text: await checkedResult(ddgSearch(query, signal), signal),
          nativeError: nativeError instanceof Error ? nativeError.message : String(nativeError),
        };
      } catch (fallbackError) {
        const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(
          `Native ${provider} search failed: ${nativeMessage}; DuckDuckGo fallback failed: ${fallbackMessage}`,
          { cause: fallbackError },
        );
      }
    }
  }
  return { text: await checkedResult(ddgSearch(query, signal), signal) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentProvider(ctx: ExtensionContext) {
  return ctx.model?.provider;
}
function getCurrentModel(ctx: ExtensionContext) {
  return ctx.model?.id ?? "";
}
function getCurrentBaseUrl(ctx: ExtensionContext) {
  return ctx.model?.baseUrl ?? "";
}
function isSearchAvailable(ctx: ExtensionContext, config: SearchConfig) {
  if (!config.enabled || !config.searchEnabled) return false;
  const p = getCurrentProvider(ctx);
  return p ? config.providerOverrides[p]?.searchEnabled !== false : false;
}
function isFetchAvailable(ctx: ExtensionContext, config: SearchConfig) {
  if (!config.enabled || !config.fetchEnabled) return false;
  const p = getCurrentProvider(ctx);
  return p ? config.providerOverrides[p]?.fetchEnabled !== false : false;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export type SearchConfigSnapshot = Readonly<Omit<SearchConfig, "providerOverrides">> & {
  readonly providerOverrides: Readonly<Record<string, Readonly<{ searchEnabled?: boolean; fetchEnabled?: boolean; searchBackend?: SearchBackendOverride }>>>;
};

export interface SearchBackendOptions {
  /** SDK children explicitly receive the approved Main discovery bus, never a module path. */
  readonly backendEvents?: SearchBackendEvents;
}
type SearchInstallOptions = SearchBackendOptions & (
  | { readonly child: true; readonly config: SearchConfigSnapshot }
  | { readonly child: false; readonly config: SearchConfigSnapshot; readonly agentDir: string });

export function createSearchChildFactory(config: SearchConfigSnapshot, options: SearchBackendOptions = {}) {
  const snapshot = structuredClone(config);
  const backendEvents = options.backendEvents;
  return (pi: ExtensionAPI): void => installSearch(pi, { child: true, config: snapshot, backendEvents });
}

/** Each install owns its config; only Main may reload or persist the agent config. */
export function installSearch(pi: ExtensionAPI, options: SearchInstallOptions) {
  const child = options.child;
  const backendEvents = options.backendEvents ?? pi.events;
  const capability = child ? undefined : installNativeSearchChildCapability(dirname(fileURLToPath(import.meta.url)));
  let config: SearchConfig = structuredClone(options.config);
  const persistConfig = (next: SearchConfig) => {
    // Publish the candidate only after persistence succeeds; failed writes keep execution guards unchanged.
    if (!options.child) saveSearchConfig(next, options.agentDir);
    config = next;
  };
  const reloadConfig = () => {
    if (!options.child) {
      try { config = loadSearchConfig(options.agentDir); }
      catch (error) {
        config = { enabled: false, searchEnabled: false, fetchEnabled: false, providerOverrides: {} };
        throw error;
      }
    }
  };

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Uses native provider search (ZAI MCP, Anthropic, Google, OpenAI, xAI), optional registered backends or DuckDuckGo fallback.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!isSearchAvailable(ctx, config))
        return {
          content: [
            {
              type: "text" as const,
              text: "Web search disabled. Use /search to enable.",
            },
          ],
          details: { error: "disabled" },
        };
      signal?.throwIfAborted();
      const provider = getCurrentProvider(ctx) ?? "";
      const model = getCurrentModel(ctx);
      const baseUrl = getCurrentBaseUrl(ctx);
      const cap = PROVIDERS[provider];
      const route = searchRoute(config, provider, discoverSearchBackends(backendEvents));
      // Optional backends resolve their own credentials inside the fallback
      // boundary. Unknown providers never trigger credential or config probes.
      const apiKey = !cap?.nativeSearch || route !== "native"
        ? undefined
        : await ctx.modelRegistry.getApiKeyForProvider(provider);
      // Anthropic's OAuth transport requires Claude Code identity and beta
      // headers; this extension's direct Messages request is API-key-only.
      // Fall back instead of sending an OAuth bearer token as x-api-key.
      // The resolved credential is authoritative for execution. Synchronous
      // auth status is presentation-only and intentionally does not gate CLI,
      // environment, or command-backed credentials.
      const hasNative = typeof route === "object" || (
        route === "native" &&
        !!cap?.nativeSearch &&
        nativeCredentialCompatible(provider, apiKey) &&
        !!apiKey);
      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `Searching${hasNative ? (typeof route === "object" ? ` (${route.label})` : ` (native: ${provider})`) : " (DuckDuckGo)"}: "${params.query}"...`,
          },
        ],
        details: {},
      });
      try {
        const { text, nativeError } = await doSearch(
          params.query,
          provider,
          model,
          baseUrl,
          apiKey,
          hasNative,
          route,
          ctx,
          signal,
        );
        const out = nativeError
          ? `> Native failed (${nativeError.slice(0, 80)}), used DuckDuckGo.\n\n${text}`
          : text;
        return {
          content: [{ type: "text" as const, text: out }],
          details: {
            query: params.query,
            provider,
            method: hasNative && !nativeError ? "native" : "ddg",
          },
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("Web search cancelled", { cause: error });
        throw error;
      }
    },
    renderCall(a, t) {
      return new Text(
        t.fg("toolTitle", t.bold("web_search ")) + t.fg("muted", `"${a.query}"`),
        0,
        0,
      );
    },
    renderResult(r, { expanded, isPartial }, t, context) {
      if (isPartial) return new Text(t.fg("warning", "Searching..."), 0, 0);
      const first = r.content[0];
      const text = first?.type === "text" ? first.text : "",
        lines = text.split("\n").length;
      if (context.isError) {
        return expanded
          ? new Text(text, 0, 0)
          : new Text(t.fg("error", "Search failed"), 0, 0);
      }
      return expanded
        ? new Text(text, 0, 0)
        : new Text(
            t.fg("success", "Found results") + t.fg("dim", ` (${lines} lines)`),
            0,
            0,
          );
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page's text content. Truncated to 50KB / 2000 lines.",
    parameters: Type.Object({ url: Type.String({ description: "URL" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!isFetchAvailable(ctx, config))
        return {
          content: [{ type: "text" as const, text: "Web fetch disabled." }],
          details: { error: "disabled" },
        };
      signal?.throwIfAborted();
      const provider = getCurrentProvider(ctx) ?? "";
      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `Fetching ${params.url}...`,
          },
        ],
        details: {},
      });
      try {
        const text = await checkedResult(httpFetch(params.url, signal), signal);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            url: params.url,
            provider,
            method: "local",
          },
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("Web fetch cancelled", { cause: error });
        throw error;
      }
    },
    renderCall(a, t) {
      return new Text(
        t.fg("toolTitle", t.bold("web_fetch ")) + t.fg("muted", a.url),
        0,
        0,
      );
    },
    renderResult(r, { expanded, isPartial }, t, context) {
      if (isPartial) return new Text(t.fg("warning", "Fetching..."), 0, 0);
      const first = r.content[0];
      const text = first?.type === "text" ? first.text : "",
        lines = text.split("\n").length;
      if (context.isError) {
        return expanded
          ? new Text(text, 0, 0)
          : new Text(t.fg("error", "Fetch failed"), 0, 0);
      }
      return expanded
        ? new Text(text, 0, 0)
        : new Text(
            t.fg("success", "Fetched") + t.fg("dim", ` (${lines} lines)`),
            0,
            0,
          );
    }
  });

  // ─── Commands ───────────────────────────────────────────────────────────

  function reply(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info") {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType: "native-search-command", content: text, display: true, details: { level } }, { triggerTurn: false });
  }

  if (!child) pi.registerCommand("search", {
    description: `Configure web search & fetch tools. ${SEARCH_USAGE}`,
    getArgumentCompletions(p) {
      const matches = SEARCH_COMMANDS.filter(c => c.startsWith(p.trimStart().toLowerCase()))
        .map(c => ({ value: c, label: c }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const sub = parseSearchCommand(args ?? "");
      if (sub === undefined) {
        reply(ctx, SEARCH_USAGE, "warning");
        return;
      }
      if (sub === "providers") {
        await showProviders(ctx);
        return;
      }
      if (sub === "config") {
        showConfig(ctx);
        return;
      }
      if (sub === "on") {
        persistConfig({ ...config, enabled: true, searchEnabled: true, fetchEnabled: true });
        pi.setActiveTools([...pi.getActiveTools(), "web_search", "web_fetch"]);
        reply(ctx, "Search enabled");
        return;
      }
      if (sub === "off") {
        persistConfig({ ...config, enabled: false });
        pi.setActiveTools(
          pi.getActiveTools().filter((t) => t !== "web_search" && t !== "web_fetch"),
        );
        reply(ctx, "Search disabled");
        return;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) { showConfig(ctx); return; }
      await showSearchSettings(ctx);
    },
  });

  // ─── Settings: only configured providers ────────────────────────────────

  async function showSearchSettings(ctx: ExtensionContext) {
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Search Extension",
          currentValue: config.enabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
        {
          id: "search",
          label: "Web Search",
          currentValue: config.searchEnabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
        {
          id: "fetch",
          label: "Web Fetch",
          currentValue: config.fetchEnabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
      ];

      const currentProvider = getCurrentProvider(ctx);
      for (const pid of Object.keys(PROVIDERS).sort()) {
        if (!hasCredentials(ctx, pid) && pid !== currentProvider) continue;
        const cap = PROVIDERS[pid]!;
        const override = config.providerOverrides[pid];
        const capability = cap.nativeSearch ? " [native-capable]" : "";
        const current = pid === currentProvider ? " ← current" : "";
        items.push({
          id: `provider:${pid}:search`,
          label: `${cap.name}${capability}${current} - Search`,
          currentValue: override?.searchEnabled === false ? "disabled" : "enabled",
          values: ["enabled", "disabled"],
        });
      }

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Search Settings"))));
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            "Showing configured providers only • /search providers for all",
          ),
        ),
      );
      container.addChild(new Text(""));

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 20),
        getSettingsListTheme(),
        (id, val) => {
          const next = structuredClone(config);
          if (id === "enabled") next.enabled = val === "enabled";
          else if (id === "search") next.searchEnabled = val === "enabled";
          else if (id === "fetch") next.fetchEnabled = val === "enabled";
          else if (id.startsWith("provider:")) {
            const pid = id.split(":")[1]!;
            if (!next.providerOverrides[pid]) next.providerOverrides[pid] = {};
            next.providerOverrides[pid]!.searchEnabled = val === "enabled";
          }
          persistConfig(next);
          applyToolsConfig(ctx);
        },
        () => done(undefined),
      );
      container.addChild(settingsList);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate • tab toggle • esc close")),
      );
      return {
        render(w: number) {
          return container.render(w);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(d: string) {
          settingsList.handleInput(d);
          tui.requestRender();
        },
      };
    });
  }

  // ─── All providers view ─────────────────────────────────────────────────

  async function showProviders(ctx: ExtensionContext) {
    const currentProvider = getCurrentProvider(ctx);
    const items: SelectItem[] = Object.entries(PROVIDERS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, cap]) => {
        const capability = cap.nativeSearch ? "native-capable" : "duckduckgo-only";
        return {
          value: id,
          label: `${cap.name}${id === currentProvider ? " ← current" : ""}${hasCredentials(ctx, id) ? " ✓" : ""}`,
          description: `search: ${capability} | credential: ${hasCredentials(ctx, id) ? "yes" : "no"}`,
        };
      });

    if (ctx.mode !== "tui" || !ctx.hasUI) {
      reply(ctx, items.map(item => `${item.value}: ${item.description}`).join("\n"));
      return;
    }
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("All Providers"))));
      container.addChild(new Text(theme.fg("dim", "✓ = credential available")));
      container.addChild(new Text(""));
      const sl = new SelectList(items, Math.min(items.length, 15), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      sl.onSelect = () => {};
      sl.onCancel = () => done(undefined);
      container.addChild(sl);
      container.addChild(new Text(theme.fg("dim", "esc close")));
      return {
        render(w: number) {
          return container.render(w);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(d: string) {
          sl.handleInput(d);
          tui.requestRender();
        },
      };
    });
  }

  function showConfig(ctx: ExtensionContext) {
    const provider = getCurrentProvider(ctx);
    const model = getCurrentModel(ctx);
    const baseUrl = getCurrentBaseUrl(ctx);
    const cap = provider ? PROVIDERS[provider] : undefined;
    reply(ctx,
      [
        `Extension: ${config.enabled ? "enabled" : "disabled"}`,
        `Search: ${config.searchEnabled ? "enabled" : "disabled"} | Fetch: ${config.fetchEnabled ? "enabled" : "disabled"}`,
        ``,
        `Provider: ${cap?.name ?? provider ?? "?"} ${hasCredentials(ctx, provider ?? "") ? "✓" : "✗"}`,
        `Model: ${model || "?"}`,
        `Base URL: ${baseUrl || "?"}`,
        `Native capability: ${cap?.nativeSearch ? "yes" : "no"} | Route uses the effective credential at call time | Fallback: DuckDuckGo`,
      ].join("\n"),
      "info",
    );
  }

  // ─── Apply ──────────────────────────────────────────────────────────────

  function applyToolsConfig(ctx: ExtensionContext) {
    // The SDK Host owns the frozen child allowlist; config only guards execution.
    if (child) return;
    const a = pi
      .getActiveTools()
      .filter((t) => t !== "web_search" && t !== "web_fetch");
    if (config.enabled && isSearchAvailable(ctx, config)) a.push("web_search");
    if (config.enabled && isFetchAvailable(ctx, config)) a.push("web_fetch");
    pi.setActiveTools(a);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (child) return;
    if (!config.enabled) {
      ctx.ui.setStatus("search", undefined);
      return;
    }
    const p = getCurrentProvider(ctx);
    const model = getCurrentModel(ctx);
    const cap = p ? PROVIDERS[p] : undefined;
    const route = p ? searchRoute(config, p, discoverSearchBackends(backendEvents)) : "ddg";
    const m = typeof route === "object" ? route.label : route !== "ddg" && cap?.nativeSearch && hasCredentials(ctx, p ?? "")
      ? `native-capable:${p === "zai" ? "mcp" : model || "?"}`
      : "ddg";
    const fetchBackend = "fetch";
    const parts: string[] = [];
    if (config.searchEnabled) parts.push(`search:${m}`);
    if (config.fetchEnabled) parts.push(fetchBackend);
    ctx.ui.setStatus(
      "search",
      parts.length
        ? ctx.ui.theme.fg("accent", `search[${parts.join(",")}]`)
        : undefined,
    );
  }

  pi.on("session_start", async (_, ctx) => {
    capability?.bind(ctx);
    reloadConfig();
    applyToolsConfig(ctx);
    updateStatus(ctx);
  });
  pi.on("model_select", async (_, ctx) => {
    reloadConfig();
    applyToolsConfig(ctx);
    updateStatus(ctx);
  });
  pi.on("session_tree", async (_, ctx) => {
    reloadConfig();
    applyToolsConfig(ctx);
    updateStatus(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    capability?.release(ctx);
    capability?.dispose();
  });
}

export default function searchExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const config = loadSearchConfig(agentDir);
  installSearch(pi, { child: false, config, agentDir });
}
