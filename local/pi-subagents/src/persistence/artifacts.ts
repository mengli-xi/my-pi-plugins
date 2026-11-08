import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { generateDomainId } from "../domain/ids.js";
import { inspectPrivateFile, readPrivateFile, syncDirectory, writePrivateFileExclusive, type SafeFsOptionsV1 } from "./fs-safe.js";
import type { AgentRecordV1 } from "./types.js";

const HARD_CONVERSATION_BYTES = 67_108_864;

export interface AgentArtifactValidationV1 {
  readonly ok: boolean;
  readonly conversationBytes: number;
  readonly conversationMtimeMs: number;
  readonly leafId?: string;
  readonly repairedTailBytes: number;
  readonly reason?: "conversation-corrupt" | "capability-drift";
  readonly detail?: string;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function safeDetail(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.replace(/[\r\n\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 512) || "artifact validation failed"; }

async function repairTruncatedTail(path: string, bytes: Buffer, recoveryDirectory: string, expectedSessionId: string, options?: SafeFsOptionsV1): Promise<{ bytes: Buffer; repaired: number }> {
  if (bytes.length === 0 || bytes.at(-1) === 0x0a) return { bytes, repaired: 0 };
  const lastLf = bytes.lastIndexOf(0x0a);
  const complete = bytes.subarray(0, lastLf + 1);
  const tail = bytes.subarray(lastLf + 1);
  try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tail)); return { bytes, repaired: 0 }; } catch { /* only malformed final bytes are repairable */ }
  const original = await inspectPrivateFile(path, options);
  const transactionId = generateDomainId("txn");
  const temporary = join(dirname(path), `.repair-${transactionId}.jsonl`);
  try {
    await writePrivateFileExclusive(temporary, complete, options);
    // Semantic/header/parent-chain validation happens on the private candidate
    // before the authoritative conversation is modified.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(complete);
    const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = lines.shift();
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== expectedSessionId) throw new Error("conversation repair candidate header is invalid");
    const seen = new Set<string>();
    for (const entry of lines) {
      if (typeof entry.id !== "string" || seen.has(entry.id)) throw new Error("conversation repair candidate has invalid/duplicate entry id");
      if (entry.parentId !== null && (typeof entry.parentId !== "string" || !seen.has(entry.parentId))) throw new Error("conversation repair candidate has a dangling parent");
      seen.add(entry.id);
    }
    const manager = SessionManager.open(temporary, dirname(temporary));
    if (manager.getSessionId() !== expectedSessionId || manager.getHeader()?.version !== 3) throw new Error("conversation repair candidate identity is invalid");
    const current = await inspectPrivateFile(path, options);
    if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size) throw new Error("conversation changed during repair validation");
    const stamp = new Date().toISOString().replace(/[-:]/gu, "");
    const recovery = join(recoveryDirectory, `${stamp}-${transactionId}.tail`);
    await writePrivateFileExclusive(recovery, tail, options);
    await syncDirectory(recoveryDirectory, options);
    await rename(temporary, path);
    await syncDirectory(dirname(path), options);
    return { bytes: Buffer.from(complete), repaired: tail.length };
  } catch (error) {
    await rm(temporary).catch(() => undefined);
    throw error;
  }
}

export async function validateAgentArtifactsV1(mainRoot: string, agent: AgentRecordV1, options?: SafeFsOptionsV1): Promise<AgentArtifactValidationV1> {
  const conversationPath = join(mainRoot, agent.conversation.relative_path);
  const promptPath = join(mainRoot, agent.profile.system_prompt_relative_path);
  try {
    const promptStats = await inspectPrivateFile(promptPath, options);
    if (promptStats.size !== agent.profile.system_prompt_bytes) throw new Error("system prompt byte length drifted");
    const prompt = await readPrivateFile(promptPath, 1_048_576, options);
    if (sha256(prompt) !== agent.profile.system_prompt_sha256) throw new Error("system prompt digest drifted");
    const promptText = new TextDecoder("utf-8", { fatal: true }).decode(prompt);
    if (!promptText.endsWith("\n") || /\r/u.test(promptText)) throw new Error("system prompt is not LF-normalized");

    let conversation = await readPrivateFile(conversationPath, HARD_CONVERSATION_BYTES, options);
    if (conversation.length < agent.conversation.initial_bytes) throw new Error("conversation is shorter than immutable initial artifact");
    if (sha256(conversation.subarray(0, agent.conversation.initial_bytes)) !== agent.conversation.initial_sha256) throw new Error("conversation initial artifact digest drifted");
    const repaired = await repairTruncatedTail(conversationPath, conversation, join(mainRoot, "recovery"), agent.conversation.session_id, options);
    conversation = repaired.bytes;
    const manager = SessionManager.open(conversationPath, dirname(conversationPath));
    if (manager.getSessionId() !== agent.conversation.session_id) throw new Error("conversation session identity drifted");
    const header = manager.getHeader();
    if (!header || header.version !== 3 || header.id !== agent.conversation.session_id) throw new Error("conversation header is invalid");
    const stats = await inspectPrivateFile(conversationPath, options);
    return Object.freeze({ ok: true, conversationBytes: conversation.length, conversationMtimeMs: stats.mtimeMs, ...(manager.getLeafId() ? { leafId: manager.getLeafId()! } : {}), repairedTailBytes: repaired.repaired });
  } catch (error) {
    const promptRelated = /system prompt/u.test(error instanceof Error ? error.message : "");
    let bytes = 0; let mtimeMs = 0;
    try { const stats = await inspectPrivateFile(conversationPath, options); bytes = stats.size; mtimeMs = stats.mtimeMs; } catch { /* bounded unavailable result */ }
    return Object.freeze({ ok: false, conversationBytes: bytes, conversationMtimeMs: mtimeMs, repairedTailBytes: 0, reason: promptRelated ? "capability-drift" : "conversation-corrupt", detail: safeDetail(error) });
  }
}
