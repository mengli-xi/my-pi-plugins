import { open, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Buffered async JSONL output so the profiler cannot stall the frame it measures. */
export class JsonlWriter {
  private readonly path: string;
  error?: string;
  private queued: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(path: string) {
    this.path = path;
  }

  write(entry: Record<string, unknown>): void {
    this.queued.push(`${JSON.stringify(entry)}\n`);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 1000);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const payload = this.queued.join("");
    this.queued = [];
    if (!payload) return this.writing;
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await chmod(dirname(this.path), 0o700);
        const file = await open(this.path, "a", 0o600);
        try { await file.chmod(0o600); await file.writeFile(payload, "utf8"); } finally { await file.close(); }
        this.error = undefined;
      })
      .catch((error) => {
        // Keep the failure visible without interrupting the session.
        this.error = `log write failed: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
      });
    return this.writing;
  }
}
