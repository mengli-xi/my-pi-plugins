import type { TelemetryAttribute, TelemetryAttributes } from "./telemetry.ts";

export type PerfTimelineSource = "ui" | "plugin" | "runtime";

export interface PerfTimelineSample {
  at: number;
  source: PerfTimelineSource;
  owner: string;
  metric: string;
  value: number;
  unit: string;
  interaction?: number;
  attributes?: TelemetryAttributes;
}

export interface PerfTimelineInput extends Omit<PerfTimelineSample, "at" | "attributes"> {
  at?: number;
  attributes?: Record<string, unknown>;
}

const MAX_TEXT = 160;

function safeAttributes(attributes?: Record<string, unknown>): TelemetryAttributes | undefined {
  if (!attributes) return undefined;
  const result: TelemetryAttributes = {};
  for (const [rawName, rawValue] of Object.entries(attributes).slice(0, 16)) {
    const name = rawName.trim().slice(0, 64);
    if (!name || rawValue === undefined) continue;
    let value: TelemetryAttribute | undefined;
    if (typeof rawValue === "string") value = rawValue.slice(0, MAX_TEXT);
    else if (typeof rawValue === "boolean") value = rawValue;
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) value = rawValue;
    if (value !== undefined) result[name] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Fixed-capacity chronological ring; no shifting or unbounded history. */
export class PerfTimeline {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly buffer: Array<PerfTimelineSample | undefined>;
  private cursor = 0;
  private size = 0;

  constructor(capacity = 10_000, now: () => number = () => Date.now()) {
    this.capacity = Math.max(1, Math.trunc(capacity));
    this.now = now;
    this.buffer = new Array(this.capacity);
  }

  add(input: PerfTimelineInput): void {
    if (!Number.isFinite(input.value)) return;
    const owner = input.owner.trim().slice(0, 80);
    const metric = input.metric.trim().slice(0, 160);
    const unit = input.unit.trim().slice(0, 24);
    if (!owner || !metric || !unit) return;
    const interaction = Number.isFinite(input.interaction) ? Math.trunc(input.interaction!) : undefined;
    this.buffer[this.cursor] = {
      at: Number.isFinite(input.at) ? input.at! : this.now(),
      source: input.source,
      owner,
      metric,
      value: input.value,
      unit,
      ...(interaction !== undefined ? { interaction } : {}),
      ...(input.attributes ? { attributes: safeAttributes(input.attributes) } : {}),
    };
    this.cursor = (this.cursor + 1) % this.capacity;
    this.size = Math.min(this.capacity, this.size + 1);
  }

  snapshot(): PerfTimelineSample[] {
    const start = this.size < this.capacity ? 0 : this.cursor;
    const rows: PerfTimelineSample[] = [];
    for (let index = 0; index < this.size; index++) {
      const row = this.buffer[(start + index) % this.capacity];
      if (row) rows.push({ ...row, ...(row.attributes ? { attributes: { ...row.attributes } } : {}) });
    }
    return rows;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.cursor = 0;
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }
}
