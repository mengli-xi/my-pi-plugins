import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 重定向整个 Pi peer graph；不修改 node_modules 或任何外部 link。
const sdk = process.env.PI_PATCHED_SDK;
if (!sdk) throw new Error("需要 PI_PATCHED_SDK=/path/to/build/source/packages/coding-agent");
const require = createRequire(join(sdk, "package.json"));
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@earendil-works/")) {
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
