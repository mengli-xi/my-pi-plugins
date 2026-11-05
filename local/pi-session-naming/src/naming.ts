import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { NAMING_EFFORTS, type SessionNamingConfig } from "./config.ts";
import { SessionNamingTelemetry } from "./telemetry.ts";

const UNSAFE_TITLE_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

class NamingTimeoutError extends Error {
  constructor() {
    super("session naming timed out");
    this.name = "NamingTimeoutError";
  }
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) =>
    typeof (part as { text?: unknown })?.text === "string"
      ? (part as { text: string }).text
      : "").join("\n");
}

function roleOf(message: unknown): string {
  return typeof (message as { role?: unknown })?.role === "string"
    ? (message as { role: string }).role
    : "";
}

export function sanitizeName(raw: string, maxChars: number): string {
  let name = (stripVTControlCharacters(raw).split("\n")[0] ?? "")
    .replace(UNSAFE_TITLE_CHARACTERS, "").trim();
  name = name.replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "").trim();
  name = name.replace(/[。．.,、，;；:：!！?？]+$/g, "").trim();
  const chars = Array.from(name);
  if (chars.length > maxChars) name = chars.slice(0, maxChars).join("").trimEnd();
  return name;
}

export class SessionNamingController {
  private readonly pi: ExtensionAPI;
  private readonly getConfig: () => SessionNamingConfig;
  private name: string | undefined;
  private attempted = false;
  private generation = 0;
  private readonly telemetry: SessionNamingTelemetry;
  private agentEndEvents = 0;
  private lastOutcome = "not-started";
  private pendingAbort: AbortController | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingEvent: { messages?: unknown[] } | undefined;

  constructor(
    pi: ExtensionAPI,
    getConfig: () => SessionNamingConfig,
    telemetry = new SessionNamingTelemetry(),
  ) {
    this.pi = pi;
    this.getConfig = getConfig;
    this.telemetry = telemetry;
  }

  install(): void {
    this.pi.on("session_start", () => {
      this.cancelPending();
      this.generation++;
      this.attempted = false;
      this.pendingEvent = undefined;
      this.name = this.pi.getSessionName()?.trim() || undefined;
      this.lastOutcome = this.name ? "already-named" : "ready";
    });
    this.pi.on("session_info_changed", (event) => {
      this.name = event.name?.trim() || undefined;
    });
    this.pi.on("agent_end", (event) => {
      this.agentEndEvents++;
      this.lastOutcome = "awaiting-settle";
      this.telemetry.increment("lifecycle.agent-end");
      this.pendingEvent = event as { messages?: unknown[] };
    });
    this.pi.on("agent_settled", (_event, ctx) => {
      this.telemetry.increment("lifecycle.agent-settled");
      const pending = this.pendingEvent;
      this.pendingEvent = undefined;
      if (pending) void this.maybeGenerate(pending, ctx, this.generation);
    });
    this.pi.on("session_shutdown", () => {
      this.cancelPending();
      this.pendingEvent = undefined;
      this.generation++;
      this.name = undefined;
      this.attempted = false;
      this.telemetry.release();
    });
  }

  private cancelPending(): void {
    this.pendingAbort?.abort();
    this.pendingAbort = undefined;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  get status(): {
    agentEndEvents: number;
    attempted: boolean;
    currentName?: string;
    lastOutcome: string;
  } {
    return {
      agentEndEvents: this.agentEndEvents,
      attempted: this.attempted,
      ...(this.name ? { currentName: this.name } : {}),
      lastOutcome: this.lastOutcome,
    };
  }

  private async maybeGenerate(
    event: { messages?: unknown[] },
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) {
      this.lastOutcome = "skipped-disabled";
      this.telemetry.increment("generation.skipped-disabled");
      return;
    }
    if (this.attempted) {
      this.lastOutcome = "skipped-attempted";
      this.telemetry.increment("generation.skipped-attempted");
      return;
    }
    if (this.name || this.pi.getSessionName()?.trim()) {
      this.lastOutcome = "skipped-named";
      this.telemetry.increment("generation.skipped-named");
      return;
    }
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const firstUser = messages.find((message) => roleOf(message) === "user");
    const lastAssistant = [...messages].reverse()
      .find((message) => roleOf(message) === "assistant");
    const userText = messageText(firstUser).slice(0, 1_500).trim();
    if (!userText) {
      this.lastOutcome = "skipped-no-user-text";
      this.telemetry.increment("generation.skipped-no-user-text");
      return;
    }
    this.attempted = true;
    this.lastOutcome = "generating";

    const totalStarted = performance.now();
    const registry = ctx.modelRegistry;
    let model = ctx.model;
    const wanted = config.model === "session" ? "" : config.model;
    if (wanted) {
      const slash = wanted.indexOf("/");
      const found = slash > 0 ? registry?.find(wanted.slice(0, slash), wanted.slice(slash + 1)) : undefined;
      if (!found) {
        this.lastOutcome = "model-unavailable";
        this.telemetry.increment("generation.model-unavailable");
        this.telemetry.measure("generation.total", performance.now() - totalStarted, { outcome: "model-unavailable" });
        const message = "Session naming skipped: configured model is unavailable; no fallback was used.";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.error(message);
        return;
      }
      model = found;
    }
    if (!model || !registry) {
      this.lastOutcome = "model-unavailable";
      this.telemetry.increment("generation.model-unavailable");
      this.telemetry.measure("generation.total", performance.now() - totalStarted, {
        outcome: "model-unavailable",
      });
      return;
    }

    try {
      const assistantText = messageText(lastAssistant).slice(0, 1_000).trim();
      const context = {
        systemPrompt: [
          "You name coding sessions for a session picker.",
          `Reply with ONLY the name: at most ${config.maxChars} characters,`,
          "in the same language as the conversation, no quotes,",
          "no trailing punctuation. Name the task, not the tool.",
        ].join(" "),
        messages: [{
          role: "user" as const,
          content: [{
            type: "text" as const,
            text: `<first-user-message>\n${userText}\n</first-user-message>\n<assistant-reply>\n${assistantText}\n</assistant-reply>`,
          }],
          timestamp: Date.now(),
        }],
      };
      // Respect the model's public policy: some reasoning models reject off.
      const supported = NAMING_EFFORTS.filter((level) => {
        if (!model.reasoning) return level === "off";
        const mapped = model.thinkingLevelMap?.[level];
        return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
      });
      const effort = supported.includes(config.effort) ? config.effort : supported[0] ?? "off";
      const options = {
        ...(effort !== "off" ? { reasoning: effort } : {}),
        maxTokens: config.maxOutputTokens,
        cacheRetention: "none" as const,
        sessionId: ctx.sessionManager.getSessionId() || randomUUID(),
      };
      const route = "registry";
      const completionStarted = performance.now();
      const abort = new AbortController();
      this.pendingAbort = abort;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new NamingTimeoutError());
        }, config.timeoutMs);
        timer.unref?.();
      });
      this.pendingTimer = timer;
      let response: Awaited<ReturnType<typeof registry.complete>>;
      try {
        response = await Promise.race([
          registry.complete(model, context, {
            ...options,
            signal: abort.signal,
          }),
          timeout,
        ]);
      } finally {
        // Clear this request's own timer; drop the shared reference only while it still points here,
        // so a late settling older request cannot cancel the current request's deadline.
        if (this.pendingAbort === abort) this.pendingAbort = undefined;
        if (timer) clearTimeout(timer);
        if (this.pendingTimer === timer) this.pendingTimer = undefined;
      }
      this.telemetry.measure("generation.completion", performance.now() - completionStarted, {
        stopReason: typeof response.stopReason === "string" ? response.stopReason : "unknown",
        route,
        effort,
      });
      if (generation !== this.generation ||
        response.stopReason === "error" || response.stopReason === "aborted") {
        const outcome = generation !== this.generation ? "stale" : String(response.stopReason);
        if (generation === this.generation) this.lastOutcome = outcome;
        this.telemetry.increment(`generation.${outcome}`);
        this.telemetry.measure("generation.total", performance.now() - totalStarted, { outcome, route });
        return;
      }
      const raw = (response.content ?? [])
        .map((part) => part.type === "text" ? part.text : "")
        .join("");
      const name = sanitizeName(raw, config.maxChars);
      if (!name || this.pi.getSessionName()?.trim()) {
        const outcome = name ? "already-named" : "empty";
        if (generation === this.generation) this.lastOutcome = outcome;
        this.telemetry.increment(`generation.${outcome}`);
        this.telemetry.measure("generation.total", performance.now() - totalStarted, { outcome, route });
        return;
      }
      this.pi.setSessionName(name);
      this.name = name;
      this.lastOutcome = "success";
      this.telemetry.increment("generation.success");
      this.telemetry.measure("generation.total", performance.now() - totalStarted, {
        outcome: "success",
        route,
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "unknown";
      if (generation !== this.generation) {
        // A superseded request keeps its failure in telemetry only. The reported outcome
        // belongs to whatever the current session is doing, so a late failing older
        // request must not rewrite it, exactly as the success path already guards.
        this.telemetry.increment("generation.stale");
        this.telemetry.measure("generation.total", performance.now() - totalStarted, {
          outcome: "stale",
          error: errorName,
        });
        return;
      }
      const timeout = error instanceof NamingTimeoutError;
      this.lastOutcome = timeout ? "timeout" : `error:${errorName}`;
      this.telemetry.increment(timeout ? "generation.timeout" : "generation.error");
      this.telemetry.measure("generation.total", performance.now() - totalStarted, {
        outcome: timeout ? "timeout" : "error",
        error: errorName,
      });
      // Naming is best-effort; the session stays unnamed.
    }
  }
}
