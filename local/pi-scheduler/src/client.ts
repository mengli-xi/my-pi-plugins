/**
 * Client used by the Pi extension, tool, and command to talk to the daemon.
 * One request per connect keeps it simple and robust: the caller sends a
 * single envelope and reads a single reply. If the socket is absent or the
 * connection is refused, the caller can spawn the daemon and retry.
 */

import { connect } from "node:net";
import {
  encodeFrame,
  FrameDecoder,
  type Envelope,
  type SchedulerRequest,
  type SchedulerResponse,
} from "./protocol.ts";

export class DaemonUnavailableError extends Error {}

export interface RequestOptions {
  socketPath: string;
  timeoutMs?: number;
}

let nextId = 1;

/** Send one request and resolve with the daemon's response. */
export function request(
  body: SchedulerRequest,
  options: RequestOptions,
): Promise<SchedulerResponse> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise<SchedulerResponse>((resolve, reject) => {
    const socket = connect(options.socketPath);
    const decoder = new FrameDecoder<SchedulerResponse>();
    const id = nextId++;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("scheduler request timed out"));
    }, timeoutMs);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(encodeFrame<SchedulerRequest>({ id, body }));
    });
    socket.on("data", (chunk: string) => {
      let envelopes: Array<Envelope<SchedulerResponse>>;
      try {
        envelopes = decoder.push(chunk);
      } catch (error) {
        done(() => reject(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      const reply = envelopes.find((envelope) => envelope.id === id || envelope.id === -1);
      if (reply) done(() => resolve(reply.body));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        done(() => reject(new DaemonUnavailableError(error.message)));
      } else {
        done(() => reject(error));
      }
    });
    socket.on("close", () => {
      if (!settled) done(() => reject(new Error("scheduler connection closed early")));
    });
  });
}

/** Convenience: is a daemon answering on this socket? */
export async function ping(socketPath: string): Promise<boolean> {
  try {
    const reply = await request({ type: "ping" }, { socketPath, timeoutMs: 1_000 });
    return reply.ok === true;
  } catch {
    return false;
  }
}
