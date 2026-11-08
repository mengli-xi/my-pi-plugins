import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

const SUMMARY = "B0A_DIRECT_SUMMARY_ONLY";
const PREFIX = "B0A_MAIN_REQUEST:";

/** Native-binary regression fixture: a direct summary runs after the capture observer. */
export function installEffectiveCaptureProbe(pi: ExtensionAPI): void {
  if (!process.env.PI_SUBAGENTS_TEST_CAPTURE_LOG) return;
  let ordinal = 0;
  pi.on("context_with_system", async (event, ctx) => {
    const marker = `${PREFIX}${ctx.sessionManager.getSessionId()}:${++ordinal}`;
    await ctx.modelRegistry.streamSimple(ctx.model!, {
      messages: [{ role: "system", content: SUMMARY, timestamp: 0 }, ...convertToLlm(event.messages)],
    }, { sessionId: ctx.sessionManager.getSessionId(), signal: ctx.signal }).result();
    return { messages: [...event.messages, { role: "system", content: marker, timestamp: ordinal }] };
  });
}

/** Record only normalized transcript hashes/markers, never provider options or credentials. */
export function recordEffectiveCaptureProbe(messages: readonly Message[], sessionId: string | undefined): boolean {
  const path = process.env.PI_SUBAGENTS_TEST_CAPTURE_LOG;
  if (!path) return false;
  const summary = messages[0]?.role === "system" && messages[0].content === SUMMARY;
  const markers = messages.flatMap((message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith(PREFIX) ? [message.content] : []);
  appendFileSync(path, JSON.stringify({ sessionId, kind: summary ? "summary" : "business", messagesSha256: createHash("sha256").update(JSON.stringify(messages)).digest("hex"), markers }) + "\n", { mode: 0o600 });
  return summary;
}
