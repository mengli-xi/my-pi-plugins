import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

// Package-shaped snapshots preserve dist/src, child factory proofs and resources.
// The public entry forwards directly into one immutable tree, never moving aliases.
export function retainedBuild(root, resources = []) {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const name = `.build-${Date.now()}-${randomUUID()}`;
  const snapshot = join(dist, name);
  const output = join(snapshot, "dist");
  const discard = () => rmSync(snapshot, { recursive: true, force: true });
  process.once("exit", discard);
  mkdirSync(output, { recursive: true });
  for (const path of resources) cpSync(join(root, path), join(snapshot, path), { recursive: true });
  return {
    output,
    publish(entry = "index.js", assets = [], stableExports) {
      function forward(directory) {
        for (const file of readdirSync(directory, { withFileTypes: true })) {
          const source = join(directory, file.name);
          const path = relative(output, source);
          if (path === entry) continue;
          const destination = join(dist, path);
          if (file.isDirectory()) { forward(source); continue; }
          mkdirSync(dirname(destination), { recursive: true });
          const temporary = `${destination}.publish`;
          if (/\.(?:js|ts)$/.test(path) && !assets.includes(path)) {
            const target = `./${relative(dirname(destination), source)}`;
            const code = readFileSync(source, "utf8");
            const hasDefault = /export\s+default\b|\bas\s+default\b/.test(code);
            writeFileSync(temporary, `export * from ${JSON.stringify(target)};\n` +
              (hasDefault ? `export { default } from ${JSON.stringify(target)};\n` : ""));
          } else cpSync(source, temporary);
          renameSync(temporary, destination);
        }
      }
      // Keep the previous *published* build, not an abandoned partial output.
      const pointer = join(dist, ".current.json");
      const previous = existsSync(pointer) ? JSON.parse(readFileSync(pointer, "utf8")).split("/")[1] : undefined;
      // Publish the Pi entry last; a failed compilation never changes it.
      for (const file of readdirSync(dist)) {
        if (!file.startsWith(".build-") && file !== entry && file !== ".current.json") rmSync(join(dist, file), { recursive: true, force: true });
      }
      forward(output);
      // All production Pi entries have a default export (including Bun aliases).
      const temporary = join(dist, ".publish-entry");
      const code = stableExports ?
        'import { readFileSync } from "node:fs";\nconst implementation = await import(JSON.parse(readFileSync(new URL("./.current.json", import.meta.url), "utf8")));\nexport default implementation.default;\n' +
          stableExports.map(key => `export const ${key} = implementation.${key};\n`).join("") :
        `export * from "./${name}/dist/${entry}";\nexport { default } from "./${name}/dist/${entry}";\n`;
      // Capability main-entry proofs must remain byte/inode-stable across builds.
      if (!stableExports || !existsSync(join(dist, entry)) || readFileSync(join(dist, entry), "utf8") !== code) {
        writeFileSync(temporary, code);
        renameSync(temporary, join(dist, entry));
      }
      writeFileSync(temporary, JSON.stringify(`./${name}/dist/${entry}`));
      renameSync(temporary, join(dist, ".current.json"));
      process.removeListener("exit", discard);
      for (const old of readdirSync(dist).filter(file => file.startsWith(".build-") && file !== name && file !== previous)) {
        rmSync(join(dist, old), { recursive: true, force: true });
      }
    },
  };
}

// Graph checks inspect the immutable implementation, not the forwarding module.
export function currentBuild(root) {
  const dist = join(root, "dist");
  if (existsSync(join(dist, ".current.json"))) return dirname(join(dist, JSON.parse(readFileSync(join(dist, ".current.json"), "utf8"))));
  return dist;
}
