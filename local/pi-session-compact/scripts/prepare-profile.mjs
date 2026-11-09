import { readFile, writeFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { "agent-dir": { type: "string" }, models: { type: "string" }, "keep-recent": { type: "string", default: "20000" } } });
if (!values["agent-dir"] || !values.models) throw new Error('Usage: node scripts/prepare-profile.mjs --agent-dir <copied-test-profile> --models \'{"provider/modelId":128000}\' [--keep-recent 12000]');
const agent = await realpath(resolve(values["agent-dir"]));
for (const protectedPath of [join(homedir(), ".pi/agent"), join(homedir(), ".pi-next/agent")]) {
  if (agent === await realpath(protectedPath).catch(() => protectedPath)) throw new Error("Only an isolated copied profile may be changed");
}
const models = JSON.parse(values.models);
const keep = Number(values["keep-recent"]);
if (!Number.isSafeInteger(keep) || keep < 0 || !Object.keys(models).length) throw new Error("Invalid keep-recent/models");
const settingsPath = join(agent, "settings.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
settings.compaction = { ...settings.compaction, enabled: true, modelOverrides: { ...settings.compaction?.modelOverrides } };
for (const [key, window] of Object.entries(models)) {
  if (!key.includes("/") || !Number.isSafeInteger(window) || window < 1024) throw new Error(`Invalid model window: ${key}`);
  settings.compaction.modelOverrides[key] = { reserveTokens: Math.ceil(window * 0.1), keepRecentTokens: Math.min(keep, Math.floor(window * 0.2)) };
}
await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(JSON.stringify({ agentDir: agent, modelOverrides: settings.compaction.modelOverrides, restartRequired: true }));
