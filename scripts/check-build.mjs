// 仅供验收入口使用；一次编排中成功构建的包无需再构建。正常 build 不经过这里。
import { spawnSync } from "node:child_process";
import { readJson } from "./pi-checks.mjs";

const name = readJson("package.json").name;
if (!JSON.parse(process.env.PI_CHECK_PREBUILT ?? "[]").includes(name)) {
  const result = spawnSync("npm", ["run", "build"], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
