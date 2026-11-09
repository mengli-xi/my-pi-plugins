import { getAgentDir as piAgentDir } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

export function getAgentDir(): string {
  return resolve(piAgentDir());
}
