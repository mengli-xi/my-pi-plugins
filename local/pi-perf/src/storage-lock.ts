/** Shared by writers and compaction. Loaded only after async storage I/O, not
 * during extension evaluation. No hard links, process-list commands or shell. */
export async function withStorageLock<T>(directory: string, operation: (assertOwned: () => void) => Promise<T>, skipBusy = false): Promise<T | undefined> {
  const { lock } = await import("proper-lockfile");
  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    release = await lock(directory, { realpath: false, lockfilePath: `${directory}/.lock`,
      stale: 60_000, update: 10_000, retries: skipBusy ? 0 : { retries: 30, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
      onCompromised: error => { compromised = error; } });
  } catch (error) {
    if (skipBusy && (error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
    throw error;
  }
  const assertOwned = () => { if (compromised) throw compromised; };
  try { assertOwned(); return await operation(assertOwned); }
  finally { if (!compromised) await release(); }
}
