import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import type { ChildCapabilityManifestV1 } from "pi-runtime-contracts/child-capabilities-v1";

const written = new Map<string, { signal: string; body: string }>();
const signal = (path: string) => { const stat = lstatSync(path, { bigint: true }); return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); };

/** Test harness consent only. Never create a grant in a real/daily agent directory. */
export function grantTemporarySdkFixture(manifest: ChildCapabilityManifestV1, target: string): void {
  if (!process.env.PI_CODING_AGENT_DIR) throw new Error("SDK fixture requires an explicit isolated agentDir");
  const agentDir = realpathSync(getAgentDir()), path = join(agentDir, "sdk-provider-grants.json");
  const inside = relative(realpathSync(tmpdir()), agentDir);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("SDK fixture refuses to grant outside a temporary agentDir");
  const body = JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(manifest, target)] });
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("SDK fixture refuses a non-regular grant file");
    const current = signal(path), cached = written.get(path);
    if (cached?.signal === current && cached.body === body) return;
    if (readFileSync(path, "utf8") === body) { written.set(path, { signal: current, body }); return; }
  }
  writeFileSync(path, body, { mode: 0o600 });
  written.set(path, { signal: signal(path), body });
}
