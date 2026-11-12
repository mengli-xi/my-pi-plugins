import { PerfHistory, type Identity } from "../src/history.ts";

/** Direct storage tests supply an already-resolved identity, just as the
 * extension does after session_start. Readiness itself has separate tests. */
export function readyHistory(root: string, identity: Identity): PerfHistory {
  const history = new PerfHistory(root, identity);
  history.setIdentityReady(Promise.resolve());
  return history;
}
