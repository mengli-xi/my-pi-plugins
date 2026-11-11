import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 与 scripts/check-host.mjs 相同：PI_BIN 显式指定，缺省用仓库根安装的 Pi，
// 不回退到日常 PATH 上的二进制。
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Real-host regressions always use a private profile and the shared Pi binary rule. */
export function testPiExecutable(): string {
  return resolve(process.env.PI_BIN ?? join(repositoryRoot, "node_modules/.bin/pi"));
}