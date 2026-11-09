import type { SubagentProcessServiceV1 } from "./process-service.js";

const SERVICE = Symbol.for("pi.subagents.process-service.v1");
interface Cell {
  promise?: Promise<SubagentProcessServiceV1>;
  service?: SubagentProcessServiceV1;
}

/** Keep the process owner discoverable without importing its execution graph. */
export function getProcessServiceCellV1(): Cell {
  const globals = globalThis as typeof globalThis & { [SERVICE]?: Cell };
  return globals[SERVICE] ??= {};
}

/** Backend selection has been retired, including the former SDK opt-in. */
export function assertSdkOnlyBackend(): void {
  if (process.env.PI_SUBAGENTS_BACKEND !== undefined) throw new Error("PI_SUBAGENTS_BACKEND：后端选择已移除，只支持 SDK 同进程；请从启动器或环境中删除此变量（包括 sdk 和空值）。");
}
