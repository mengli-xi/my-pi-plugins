import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { MailboxError } from "./errors.js";
export async function canonicalAgentDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return realpath(path);
}
export function snapshotPath(agentDir: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(sessionId)) throw new MailboxError("conflict", "unsafe mailbox session ID");
  return join(agentDir, "mailbox", "v1", sessionId, "pending.json");
}
