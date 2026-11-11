import { fileURLToPath } from "node:url";

// 迁出的仓库内协作矩阵使用锁定的 stock CLI，不发现真实 profile。
process.env.PI_BIN ??= fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
process.chdir(fileURLToPath(new URL("../local/pi-subagents", import.meta.url)));
await import("./subagents/real/bash-timeout-child-e2e.test.ts");
