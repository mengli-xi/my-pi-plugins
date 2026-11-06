/** Internal fault-injection seam, deliberately absent from package exports.
 * Synchronous so the final snapshot check and native enqueue stay one segment. */
export type TransportCheckpoint = "before-body" | "after-body" | "before-control" | "after-control"
  | "request-observed" | "request-success" | "before-delivery" | "after-delivery" | "before-terminal" | "after-terminal"
  | "legacy-intent" | "after-recorded-source-ack" | "after-terminal-source-ack" | "after-recorded-ack" | "after-terminal-ack"
  | "before-snapshot-unlink" | "after-snapshot-unlink" | "before-snapshot-rmdir" | "after-snapshot-rmdir";
let observer: ((point: TransportCheckpoint) => void) | undefined;
export function setTransportCheckpointForTest(value: typeof observer): void { observer = value; }
export function checkpoint(point: TransportCheckpoint): void { observer?.(point); }
