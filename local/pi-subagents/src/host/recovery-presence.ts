import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { mainKey } from "../domain/ids.js";

/** Existing or unsafe records must pass the full store recovery, never a shallow replay. */
export async function hasStoredMainV1(agentDirectory: string, sessionId: string): Promise<boolean> {
  try {
    await lstat(join(agentDirectory, "pi-subagents", "store-v2", "mains", mainKey(sessionId)));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
