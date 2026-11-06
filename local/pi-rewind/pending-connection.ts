export interface PendingConnectionRewindRequest {
	/** Leaf that was active before the submitted user message was appended. */
	baseLeafId: string | null;
	editorText: string;
	hasImages: boolean;
}

interface CapturedInput extends PendingConnectionRewindRequest {
	capturedAt: number;
}

/**
 * Tracks a newly submitted interactive prompt until the model answers it.
 *
 * The boundary is the first streamed assistant content, not the provider
 * request: `before_provider_request` fires a few milliseconds after
 * `agent_start`, while the first thinking or text delta arrives seconds later.
 * Closing the window at the request left one Escape no time to reach it, so it
 * always fell back to a plain abort. Retries, continuations and tool turns have
 * no captured input, so they can never rewind an older user message.
 */
export class PendingConnectionRewindState {
	private input: CapturedInput | undefined;
	private staged: PendingConnectionRewindRequest | undefined;
	private active: PendingConnectionRewindRequest | undefined;
	private requested: PendingConnectionRewindRequest | undefined;

	captureInput(
		editorText: string,
		baseLeafId: string | null,
		hasImages: boolean,
		now = Date.now(),
	): void {
		this.input = { editorText, baseLeafId, hasImages, capturedAt: now };
	}

	/** Pair the most recent interactive input with the agent run it is about to start. */
	stageAgent(now = Date.now()): void {
		const input = this.input;
		this.input = undefined;
		// Covers auth and compaction preflight without retaining a failed prompt
		// indefinitely for an unrelated later continuation.
		this.staged = input && now - input.capturedAt <= 10 * 60_000
			? {
				editorText: input.editorText,
				baseLeafId: input.baseLeafId,
				hasImages: input.hasImages,
			}
			: undefined;
	}

	startAgent(): void {
		this.active = this.staged;
		this.staged = undefined;
	}

	/** First thinking/text/tool delta of the answer: the turn now has content. */
	markContentStarted(): void {
		this.active = undefined;
	}

	finishAgent(): void {
		this.active = undefined;
		this.staged = undefined;
	}

	/** Atomically reserve the one-shot Escape action for the command handler. */
	request(): boolean {
		if (!this.active || this.requested) return false;
		this.requested = this.active;
		this.active = undefined;
		return true;
	}

	takeRequested(): PendingConnectionRewindRequest | undefined {
		const request = this.requested;
		this.requested = undefined;
		return request;
	}

	reset(): void {
		this.input = undefined;
		this.staged = undefined;
		this.active = undefined;
		this.requested = undefined;
	}
}
