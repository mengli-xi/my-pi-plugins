import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getAgentDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PerfHistory, packageHash } from "../../local/pi-perf/src/history.ts";

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "binary-faux", api: "binary-faux", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage("BINARY_SMOKE_OK")]);
  pi.registerProvider(faux.provider);
  pi.on("session_start", async () => {
    const root = join(getAgentDir(), "binary-perf-storage");
    const history = new PerfHistory(root, { pid: process.pid, piVersion: VERSION, mode: "print", packages: ["binary-smoke"], packagesHash: packageHash(["binary-smoke"]) });
    history.setIdentityReady(Promise.resolve());
    // Two real writes and maintenance transactions exercise proper-lockfile's
    // per-fs precision cache in the compiled host, without waiting for timers.
    for (let i = 0; i < 2; i++) {
      history.write("session", { rss: i + 1 });
      await history.flush();
      assert.equal(history.error, undefined);
      await history.cleanup();
      assert.equal(history.maintenanceError, undefined);
    }
    const day = new Date().toISOString().slice(0, 10);
    const shard = JSON.parse(await readFile(join(root, "daily", day, `${history.run}.json`), "utf8"));
    assert.equal(shard.sessions, 2);
    console.log("BINARY_PERF_TWO_WRITES_OK");
  });
}
