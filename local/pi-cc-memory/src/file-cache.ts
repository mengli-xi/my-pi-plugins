import { stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";

const version = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");

/** Per-owner parsed-file cache; metadata is checked even when a read is already in flight. */
export function createVersionedReader<T>(read: (path: string) => Promise<T>) {
  const cache = new Map<string, { version: string; result: Promise<T> }>();
  return async (path: string): Promise<T> => {
    let current: string;
    try { current = version(await stat(path, { bigint: true })); }
    catch (error) { cache.delete(path); throw error; }
    const cached = cache.get(path);
    if (cached?.version === current) return cached.result;
    const entry: { version: string; result: Promise<T> } = {
      version: current,
      result: Promise.resolve().then(async () => {
        try {
          const value = await read(path);
          if (version(await stat(path, { bigint: true })) !== current && cache.get(path) === entry) cache.delete(path);
          return value;
        } catch (error) {
          if (cache.get(path) === entry) cache.delete(path);
          throw error;
        }
      }),
    };
    cache.set(path, entry);
    return entry.result;
  };
}
