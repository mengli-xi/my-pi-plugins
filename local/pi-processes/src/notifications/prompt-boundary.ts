export type PromptInputSourceV1 = "interactive" | "rpc" | "extension";

export type PromptBoundaryCandidateSnapshotV1 =
  | Readonly<{ state: "empty" }>
  | Readonly<{
      state: "ready";
      inputOrdinal: number;
      source: PromptInputSourceV1;
    }>
  | Readonly<{
      state: "ambiguous";
      firstOrdinal: number;
      lastOrdinal: number;
    }>;

export interface PromptBoundaryCountersV1 {
  readonly ambiguous: number;
  readonly missing: number;
}

export class PromptBoundaryCandidateV1 {
  #nextOrdinal = 1;
  #slot: PromptBoundaryCandidateSnapshotV1 = Object.freeze({ state: "empty" });
  #ambiguous = 0;
  #missing = 0;

  capture(input: { readonly source: PromptInputSourceV1; readonly streamingBehavior?: "steer" | "followUp" }): void {
    if (input.streamingBehavior !== undefined) return;
    const ordinal = this.#nextOrdinal++;
    if (this.#slot.state === "empty") {
      this.#slot = Object.freeze({ state: "ready", inputOrdinal: ordinal, source: input.source });
      return;
    }
    const firstOrdinal = this.#slot.state === "ready" ? this.#slot.inputOrdinal : this.#slot.firstOrdinal;
    this.#slot = Object.freeze({ state: "ambiguous", firstOrdinal, lastOrdinal: ordinal });
    this.#ambiguous += 1;
  }

  takeExternalBoundary(): Readonly<{ inputOrdinal: number; source: "interactive" | "rpc" }> | undefined {
    const current = this.#slot;
    this.#slot = Object.freeze({ state: "empty" });
    if (current.state === "empty") {
      this.#missing += 1;
      return undefined;
    }
    if (current.state === "ambiguous" || current.source === "extension") return undefined;
    return Object.freeze({ inputOrdinal: current.inputOrdinal, source: current.source });
  }

  reset(): void {
    this.#slot = Object.freeze({ state: "empty" });
  }

  snapshot(): PromptBoundaryCandidateSnapshotV1 { return this.#slot; }
  counters(): PromptBoundaryCountersV1 { return Object.freeze({ ambiguous: this.#ambiguous, missing: this.#missing }); }
}
