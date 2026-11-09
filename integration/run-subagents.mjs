import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// 保留迁出的跨插件矩阵。须由调用者提供真实插件/CLI，不以假实现补齐缺失包。
if (!process.env.PI_REAL_BINARY) throw new Error("设置 PI_REAL_BINARY=<Pi 1.5 CLI>；外部协作方与 patched SDK 前提见 integration/README.md");
const pkg = resolve("local/pi-subagents");
const files = readdirSync("integration/subagents/real").filter(name => name.endsWith(".test.ts"));
const result = spawnSync("node", ["--import", resolve("ts-resolve.mjs"), "--experimental-strip-types", "--test", ...files.map(name => resolve("integration/subagents/real", name))], { cwd: pkg, env: process.env, stdio: "inherit" });
process.exit(result.status ?? 1);
