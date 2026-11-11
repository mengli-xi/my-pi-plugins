import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot, piBin } from "../scripts/pi-checks.mjs";

// 保留迁出的跨插件矩阵。须由调用者提供真实插件/CLI，不以假实现补齐缺失包。
if (!process.env.PI_BIN) throw new Error("用 PI_BIN 指定 stock Pi CLI；外部协作方与 patched SDK 前提见 integration/README.md");
const pkg = resolve(repositoryRoot, "local/pi-subagents");
const env = { ...process.env, PI_BIN: piBin() };
const files = readdirSync(resolve(repositoryRoot, "integration/subagents/real")).filter(name => name.endsWith(".test.ts"));
const result = spawnSync("node", ["--import", resolve(repositoryRoot, "ts-resolve.mjs"), "--experimental-strip-types", "--test", "--test-timeout=300000", ...files.map(name => resolve(repositoryRoot, "integration/subagents/real", name))], { cwd: pkg, env, stdio: "inherit" });
process.exit(result.status ?? 1);
