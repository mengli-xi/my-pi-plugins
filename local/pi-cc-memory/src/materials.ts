import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
export interface MemoryMaterials { memory: { path: string; hash: string; contents: string }[]; known: { kind: string; statement: string }[] }
/** Selection and containment belong to the memory owner, not to its consumers. */
export async function collectMemoryMaterials(agentDir: string, memoryDir: string, context: string): Promise<MemoryMaterials> {
  const result: MemoryMaterials = { memory: [], known: [] };
  try {
    const agent = await realpath(agentDir);
    const root = await realpath(join(agent, "pi-cc-memory", "projects"));
    const dir = await realpath(memoryDir), project = relative(root, dir).split(sep).join("/");
    if (isAbsolute(project) || !/^[a-f0-9]{64}\/memory$/.test(project)) throw new Error("Memory directory outside owner's project tree");
    const file = async (name: string) => {
      const path = await realpath(join(dir, name)), rel = relative(dir, path);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Memory file outside project: ${name}`);
      const contents = await readFile(path, "utf8");
      return { path, hash: createHash("sha256").update(contents).digest("hex"), contents };
    };
    let index;
    try { index = await file("MEMORY.md"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    result.memory.push(index);
    const referenced = new Set([...index.contents.matchAll(/\]\(([^)]+\.md)\)/g)].map(match => match[1]));
    const text = context.toLowerCase();
    const names = (await readdir(dir)).filter(name => name !== "MEMORY.md" && /^[a-z0-9-]+\.md$/.test(name) && referenced.has(name));
    names.sort((a, b) => Number(text.includes(b.slice(0, -3))) - Number(text.includes(a.slice(0, -3))) || a.localeCompare(b));
    for (const name of names.slice(0, 8)) {
      try { result.memory.push(await file(name)); }
      catch (error) { result.known.push({ kind: "memory-source", statement: `Memory topic ${name} read failed: ${String(error)}` }); }
    }
    if (names.length > 8) result.known.push({ kind: "memory-coverage", statement: `${names.length - 8} indexed memory topics were not read; relevance selection is heuristic.` });
  } catch (error) {
    result.known.push({ kind: "memory-source", statement: `Current memory read failed: ${String(error)}` });
  }
  return result;
}
