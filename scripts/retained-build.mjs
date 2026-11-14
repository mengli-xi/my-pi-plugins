import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

function lockBuild(dist) {
  const lock = join(dist, ".lock"), owner = String(process.pid), pending = mkdtempSync(join(dist, ".lock-"));
  writeFileSync(join(pending, owner), "");
  const release = pid => {
    try { unlinkSync(join(lock, pid)); rmdirSync(lock); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A nonempty directory cannot be replaced by rename: ownership is atomic.
      try { renameSync(pending, lock); return () => release(owner); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
      let pid;
      try { [pid] = readdirSync(lock); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!pid) continue; // An interrupted release left an empty directory.
      try { process.kill(Number(pid), 0); }
      catch (error) { if (error.code !== "ESRCH") throw error; release(pid); continue; }
      throw new Error(`Build already running (pid ${pid}): ${dist}`);
    }
    throw new Error(`Build lock changed; retry: ${dist}`);
  } finally { rmSync(pending, { recursive: true, force: true }); }
}

function readCurrent(dist) {
  try {
    const target = JSON.parse(readFileSync(join(dist, ".current.json"), "utf8"));
    return typeof target === "string" && /^\.\/\.build-[\w-]+\/dist\/[^/]+$/.test(target) ? target : undefined;
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
}

export function retainedBuild(root, resources = []) {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const unlock = lockBuild(dist), name = `.build-${randomUUID()}`, snapshot = join(dist, name), output = join(snapshot, "dist");
  let published = false;
  process.once("exit", () => { try { if (!published) rmSync(snapshot, { recursive: true, force: true }); } finally { unlock(); } });
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  mkdirSync(output, { recursive: true });
  for (const path of resources) cpSync(join(root, path), join(snapshot, path), { recursive: true });
  return {
    output,
    publish(entry = "index.js", stableExports, publicModules = []) {
      const previous = readCurrent(dist)?.split("/")[1];
      const write = (file, code) => { writeFileSync(join(dist, ".publish-entry"), code); renameSync(join(dist, ".publish-entry"), join(dist, file)); };
      for (const module of publicModules) for (const ext of [".js", ".d.ts"]) write(module + ext, `export * from "./${name}/dist/${module}.js";\n`);
      const code = stableExports ?
        'import { readFileSync } from "node:fs";\nconst implementation = await import(JSON.parse(readFileSync(new URL("./.current.json", import.meta.url), "utf8")));\nexport default implementation.default;\n' +
          stableExports.map(key => `export const ${key} = implementation.${key};\n`).join("") :
        `export * from "./${name}/dist/${entry}";\nexport { default } from "./${name}/dist/${entry}";\n`;
      // Preserve Main proof bytes/inode; its implementation is captured once.
      if (!existsSync(join(dist, entry)) || readFileSync(join(dist, entry), "utf8") !== code) write(entry, code);
      write(".current.json", JSON.stringify(`./${name}/dist/${entry}`));
      published = true;
      const keep = new Set([name, previous, ".lock", entry, ".current.json", ...publicModules.flatMap(module => [module + ".js", module + ".d.ts"])]);
      for (const file of readdirSync(dist)) if (!keep.has(file) && !file.startsWith(".lock-")) rmSync(join(dist, file), { recursive: true, force: true });
    },
  };
}

export function currentBuild(root) {
  const dist = join(root instanceof URL ? fileURLToPath(root) : root, "dist");
  const target = readCurrent(dist);
  return target ? dirname(join(dist, target)) : dist;
}
