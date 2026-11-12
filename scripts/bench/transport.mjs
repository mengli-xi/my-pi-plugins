import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";

// 宿主和 Jiti 分别解析探针时仍共用同一条流。
const key = Symbol.for("pi.benchmark.transport");
export function emit(record) {
  const line = JSON.stringify({ at: performance.now(), ...record }) + "\n";
  appendFileSync(process.env.PI_BENCH_METRICS, line);
  if (!process.env.PI_BENCH_SOCKET) return;
  const socket = (globalThis[key] ??= createConnection(process.env.PI_BENCH_SOCKET).unref());
  socket.write(line);
}
