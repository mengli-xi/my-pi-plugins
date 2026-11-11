import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";

export const piBinary = process.env.PI_BIN ?? (() => {
  throw new Error("用 PI_BIN 指定 stock Pi CLI 用于隔离 fresh-host 测试。");
})();
export async function prepareFreshProfile(home: string, maxDepth: 1 | 2 = 1, order: "default" | "reverse" = "default"): Promise<string> {
  if (process.env.PI_MAILBOX_FULL_PROFILE === "1") {
    const { prepareFullProfile } = await import(new URL("../../../../scripts/mailbox/release-profile.mjs", import.meta.url).href);
    const { agent } = prepareFullProfile(home, { order: order === "reverse" ? "reverse" : "forward", includeMC: process.env.PI_MAILBOX_INCLUDE_MC === "1" });
    await mkdir(join(agent, "pi-subagents"), { recursive: true, mode: 0o700 });
    await writeFile(join(agent, "pi-subagents/config.json"), JSON.stringify({ schemaVersion: 2, execution: { maxDepth } }));
    return agent;
  }

  const agent = join(home, ".pi", "agent");
  await mkdir(agent, { recursive: true, mode: 0o700 });
  const auth = join(home, "faux-auth.json");
  await writeFile(auth, "{}\n", { mode: 0o600 });
  await symlink(auth, join(agent, "auth.json"));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], retry: { enabled: false }, quietStartup: true }));
  await mkdir(join(agent, "pi-subagents"), { recursive: true, mode: 0o700 });
  await writeFile(join(agent, "pi-subagents", "config.json"), JSON.stringify({ schemaVersion: 2, execution: { maxDepth } }));
  return agent;
}
