import { chmod, mkdir, rename, writeFile,rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export async function writeRun(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await chmod(dirname(dirname(path)),0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  try{await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });await rename(temp, path);}
  finally{await rm(temp,{force:true}).catch(()=>{});}
}
