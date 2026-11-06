import { appendFileSync } from "node:fs";

const LOG = process.env.PI_REWIND_TRACE_LOG;

/**
 * Phase timing for one rewind. Off unless PI_REWIND_TRACE_LOG names a file,
 * so a normal session never touches the filesystem for this.
 */
export function traceRewind(phase: string, extra: Record<string, unknown> = {}): void {
	if (!LOG) return;
	try {
		appendFileSync(
			LOG,
			`${JSON.stringify({ t: Number(process.hrtime.bigint() / 1000n), wall: Date.now(), phase, ...extra })}\n`,
		);
	} catch {
		// Tracing must never break a rewind.
	}
}
