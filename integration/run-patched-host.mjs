import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdk = process.env.PI_PATCHED_SDK, cli = process.env.PI_PATCHED_CLI;
if (!sdk || !cli || !existsSync(join(sdk, "dist/index.js")) || !existsSync(cli)) {
  throw new Error("无 CC child 视图联测需要同次构建的 Pi 1.5 主题补丁宿主：设置 PI_PATCHED_SDK=<build>/source/packages/coding-agent 和 PI_PATCHED_CLI=<sdk>/dist/bundle/cli.js；构建方法见 host-patches/pi/v1.5.0/README.md。不会 skip 或伪造 capability。");
}
const build = spawnSync("npm", ["run", "build", "-w", "pi-subagents"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const loader = pathToFileURL(resolve("integration/patched-sdk-loader.mjs")).href;
const result = spawnSync("bun", ["integration/subagent-no-presentation.mjs"], {
  stdio: "inherit", env: { ...process.env, NODE_OPTIONS: `--loader=${loader}` },
});
process.exit(result.status ?? 1);
