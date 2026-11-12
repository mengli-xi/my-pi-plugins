import { open, chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** 细粒度日志超过这个大小就轮转一次，只保留一份旧文件。 */
export const LOG_ROTATE_BYTES = 64 * 1024 * 1024;

/** Buffered async JSONL output so the profiler cannot stall the frame it measures. */
export class JsonlWriter {
  private readonly path: string;
  private readonly rotateBytes: number;
  error?: string;
  private queued: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(path: string, rotateBytes = LOG_ROTATE_BYTES) {
    this.path = path;
    this.rotateBytes = rotateBytes;
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
        const size = await stat(this.path).then(info => info.size, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return 0; throw error; });
        // 别的进程可能刚轮转过，文件不在了就直接新建
        if (size > 0 && size + Buffer.byteLength(payload) > this.rotateBytes) {
          await rename(this.path, `${this.path}.1`).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
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
