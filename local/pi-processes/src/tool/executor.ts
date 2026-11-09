import type { ProcessesConfig } from "../config.js";
import type { ProcessResultV2, ProcessSummary } from "../domain/types.js";
import type {
  ProcessClearResult,
  ProcessConfigureResult,
  ProcessHost,
  ProcessInputResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStopResult,
} from "../host/process-host.js";
import { parseToolInput, type ToolInput } from "./input.js";

export type ProcessToolData =
  | { readonly process: ProcessSummary }
  | { readonly items: readonly ProcessSummary[]; readonly returned: number; readonly hasMore: boolean; readonly nextCursor?: string }
  | ProcessLogsResult
  | ProcessInputResult
  | (ProcessConfigureResult & { readonly previousRevision: number })
  | ProcessStopResult
  | (ProcessClearResult & { readonly clearedCount: number; readonly remainingLive: number; readonly remainingTerminal: number });

export type V2SuccessEnvelope = ProcessResultV2<ToolInput["action"], ProcessToolData>;

export interface ProcessToolExecutorOptions {
  readonly host: ProcessHost;
  readonly config: () => ProcessesConfig;
  readonly defaultCwd: () => string;
}

function success<A extends ToolInput["action"], D>(action: A, hostRevision: number, data: D): ProcessResultV2<A, D> {
  return { version: 2, action, outcome: "success", hostRevision, data };
}

function processCounts(host: ProcessHost): { live: number; terminal: number } {
  let live = 0;
  let terminal = 0;
  for (const record of host.records()) {
    if (["starting", "running", "stopping"].includes(record.state)) live += 1;
    else terminal += 1;
  }
  return { live, terminal };
}

export class ProcessToolExecutor {
  #host: ProcessHost;
  #config: () => ProcessesConfig;
  #defaultCwd: () => string;

  constructor(options: ProcessToolExecutorOptions) {
    this.#host = options.host;
    this.#config = options.config;
    this.#defaultCwd = options.defaultCwd;
  }

  async execute(rawInput: unknown): Promise<V2SuccessEnvelope> {
    const input = parseToolInput(rawInput, this.#config().managed);
    switch (input.action) {
      case "start": {
        const process = await this.#host.start(input, this.#config(), this.#defaultCwd());
        return success(input.action, this.#host.hostRevision, { process });
      }
      case "list": {
        const result: ProcessListResult = this.#host.list(input);
        return success(input.action, this.#host.hostRevision, {
          items: result.processes,
          returned: result.processes.length,
          hasMore: result.nextCursor !== undefined,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        });
      }
      case "logs": {
        const result = await this.#host.logs(input);
        return success(input.action, this.#host.hostRevision, result);
      }
      case "input": {
        const result = await this.#host.input(input);
        return success(input.action, this.#host.hostRevision, result);
      }
      case "configure": {
        const previousRevision = this.#host.hostRevision;
        const result = await this.#host.configure(input);
        return success(input.action, this.#host.hostRevision, { ...result, previousRevision });
      }
      case "stop": {
        const result = await this.#host.stop(input);
        return success(input.action, this.#host.hostRevision, result);
      }
      case "clear": {
        const result = await this.#host.clear();
        const counts = processCounts(this.#host);
        return success(input.action, this.#host.hostRevision, {
          ...result,
          clearedCount: result.cleared.length,
          remainingLive: counts.live,
          remainingTerminal: counts.terminal,
        });
      }
    }
  }
}
