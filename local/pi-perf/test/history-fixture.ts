import { readFileSync } from "node:fs";
import { PerfHistory, type Identity } from "../src/history.ts";

// 与根宿主检查使用同一份已安装 SDK 元数据，不加载整个 SDK。
export const PI_VERSION: string = JSON.parse(readFileSync(new URL("../../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version;

/** Direct storage tests supply an already-resolved identity, just as the
 * extension does after session_start. Readiness itself has separate tests. */
export function readyHistory(root: string, identity: Identity): PerfHistory {
  const history = new PerfHistory(root, identity);
  history.setIdentityReady(Promise.resolve());
  return history;
}
