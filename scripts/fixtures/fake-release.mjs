import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binarySource } from "../pi-binary.mjs";

export function fakeRelease(root, version, { badHash = false, missing = false, versionProbe = "" } = {}) {
  const release = join(root, "release");
  mkdirSync(join(release, "package"), { recursive: true });
  writeFileSync(join(release, "package/pi"), `#!/bin/sh\n${versionProbe}\necho ${version}\n`, { mode: 0o755 });
  const { asset } = binarySource(version);
  execFileSync("tar", ["-czf", join(release, asset), "-C", release, "package"]);
  const sha256 = createHash("sha256").update(readFileSync(join(release, asset))).digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${badHash ? "0".repeat(64) : sha256}  ${asset}\n`);
  mkdirSync(join(root, "bin"), { recursive: true });
  // 离线替身也要求下载与跳转都限于 HTTPS。
  writeFileSync(join(root, "bin/curl"), missing ? "#!/bin/sh\nexit 22\n" : `#!/bin/sh
[ "$1" = --proto ] && [ "$2" = =https ] && [ "$3" = --proto-redir ] && [ "$4" = =https ] || exit 23
while [ "$1" != --output ]; do shift; done
file="${"$"}{3##*/}"
cp '${release}/'"$file" "$2"
`, { mode: 0o755 });
  return sha256;
}
