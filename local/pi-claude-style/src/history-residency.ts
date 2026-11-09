import { Container, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { historyWindowStart } from "./history-window.ts";
import { HistoryAnchor, historyBatchDistance, historyComponentIdentity, historyEvictions, rememberHistoryExpansion, type HistoryStickySpan, type ResidentHistoryBatch } from "./history-batches.ts";

interface Measure { rows: number; width: number; summary?: string }
interface Batch extends ResidentHistoryBatch {
  components?: Component[];
  anchor?: HistoryAnchor;
  measurements: WeakMap<Component, Measure>;
  expansion: Map<string, boolean>;
  expansionBindings: WeakSet<Component>;
  anchors?: ComponentAnchor[];
  sealed: boolean;
}
interface ComponentAnchor { key?: string; kind: unknown; signature?: string; ordinal: number; top: number; rows: number }
interface BatchPosition { batch: Batch; top: number; rows: number; anchors?: ComponentAnchor[] }
export interface HistoryViewport {
  top: number; height: number; width: number; chatTop: number;
  selected?: { start: number; end: number };
  expanded?: boolean;
  idle: boolean;
}
export interface HistoryResidencyOptions {
  chat: Container;
  prefix: Component[];
  header?: Component;
  branch: readonly SessionEntry[];
  start: number;
  components: Component[];
  draw(start: number, end: number): Component[];
  project(entries: readonly SessionEntry[]): void;
  sticky(component: Component): string | undefined;
  changed(start: number): void;
  request(): void;
}
export interface HistoryTransition {
  top: number;
  rows: number;
  mapRow(row: number): number;
}

/** One view's cache: immutable session records remain in SessionManager;
 * only loaded components, their measured heights and small fold overrides live here. */
export class HistoryResidency {
  private readonly options: Omit<HistoryResidencyOptions, "components" | "branch" | "start">;
  private branch: readonly SessionEntry[];
  private readonly batches: Batch[];
  private viewport?: HistoryViewport;
  private requested?: Batch;
  private requestedKey?: string;
  private earlier = false;
  private clock = 0;
  private globalExpanded?: boolean;

  constructor(options: HistoryResidencyOptions) {
    const { components, branch, start, ...callbacks } = options;
    this.options = callbacks;
    this.branch = branch;
    this.batches = [this.batch(start, branch.length, components)];
  }
  get start(): number { return this.batches[0]?.start ?? 0; }
  entries(): readonly SessionEntry[] {
    return this.batches.flatMap(batch => batch.loaded ? this.branch.slice(batch.start, batch.end) : []);
  }
  private batch(start: number, end: number, components?: Component[]): Batch {
    return { start, end, components, rows: 0, top: 0, loaded: !!components, touched: ++this.clock,
      measurements: new WeakMap(), expansion: new Map(), expansionBindings: new WeakSet(), sealed: true };
  }
  requestEarlier(): void { this.earlier = true; this.options.request(); }
  private requestBatch(batch: Batch, key?: string): void { this.requested = batch; this.requestedKey = key; this.options.request(); }

  observe(viewport: HistoryViewport, branch?: readonly SessionEntry[]): boolean {
    const previous = this.viewport;
    this.viewport = viewport;
    if (viewport.expanded !== undefined) {
      if (this.globalExpanded !== undefined && viewport.expanded !== this.globalExpanded) for (const batch of this.batches) batch.expansion.clear();
      this.globalExpanded = viewport.expanded;
    }
    if (branch) this.branch = branch;
    this.captureTail(viewport);
    this.positions(viewport);
    return this.earlier || !!this.requested || !previous || previous.top !== viewport.top || previous.width !== viewport.width
      || this.needsLoad(viewport) || this.overBudget(viewport);
  }
  private captureTail(view: HistoryViewport): void {
    const last = this.batches.at(-1)!;
    const prefix = this.roots(false);
    const children = this.options.chat.children;
    if (prefix.some((component, index) => children[index] !== component)) throw new Error("history cache prefix changed outside native rebuild");
    const remaining = children.slice(prefix.length);
    const old = last.components ?? [];
    const grew = remaining.length !== old.length || remaining.some((component, index) => component !== old[index]);
    if (last.sealed && grew && this.branch.length > last.end
      && this.branch.slice(last.end).some(entry => entry.type === "message" && entry.message.role === "user") && old.length > 0) {
      if (old.some((component, index) => remaining[index] !== component)) throw new Error("completed history batch changed before live append");
      const next = this.batch(last.end, this.branch.length, remaining.slice(old.length));
      next.sealed = view.idle;
      this.batches.push(next);
      this.measure(next, view.width);
    } else {
      last.components = remaining;
      last.end = this.branch.length;
      last.sealed = view.idle;
      this.measure(last, view.width);
    }
  }
  private roots(includeLast = true): Component[] {
    return [...this.options.prefix, ...(this.options.header ? [this.options.header] : []),
      ...this.batches.slice(0, includeLast ? undefined : -1).flatMap(batch => batch.components ?? (batch.anchor ? [batch.anchor] : []))];
  }
  private measure(batch: Batch, width: number, refresh = false): void {
    const components = batch.components;
    if (!components) return;
    rememberHistoryExpansion(components, batch.expansion, batch.expansionBindings);
    for (const component of components) {
      let measure = batch.measurements.get(component);
      if (!measure) {
        const target = measure = { rows: 0, width: -1, summary: this.options.sticky(component) };
        const original = component.render;
        component.render = function (columns) {
          const lines = original.call(this, columns);
          target.rows = lines.length; target.width = columns;
          return lines;
        };
        batch.measurements.set(component, target);
      }
      if (refresh || measure.width !== width) component.render(width);
    }
    batch.rows = components.reduce((sum, component) => sum + batch.measurements.get(component)!.rows, 0);
  }
  private positions(view: HistoryViewport): void {
    let offset = view.chatTop;
    for (const component of this.options.prefix) offset += component.render(view.width).length;
    if (this.options.header) offset += this.options.header.render(view.width).length;
    for (const batch of this.batches) {
      if (batch.loaded) this.measure(batch, view.width);
      batch.top = offset; offset += batch.rows;
      if (historyBatchDistance(batch, view.top, view.top + view.height) === 0) batch.touched = ++this.clock;
    }
  }
  private nearby(view: HistoryViewport): Set<number> {
    const result = new Set<number>();
    this.batches.forEach((batch, index) => {
      if (historyBatchDistance(batch, view.top, view.top + view.height) === 0) {
        for (const neighbor of [index - 1, index, index + 1]) if (neighbor >= 0 && neighbor < this.batches.length) result.add(neighbor);
      }
    });
    return result;
  }
  private protected(view: HistoryViewport): Set<number> {
    const protectedBatches = this.nearby(view);
    protectedBatches.add(this.batches.length - 1);
    this.batches.forEach((batch, index) => {
      if (view.selected && batch.top <= view.selected.end && batch.top + batch.rows >= view.selected.start) protectedBatches.add(index);
      if (!batch.sealed) protectedBatches.add(index);
    });
    return protectedBatches;
  }
  private needsLoad(view: HistoryViewport): boolean {
    return [...this.nearby(view)].some(index => !this.batches[index]!.loaded);
  }
  private overBudget(view: HistoryViewport): boolean {
    return historyEvictions(this.batches, view.top, view.top + view.height, this.protected(view)).length > 0;
  }
  /** Compaction changes context markers, not the residency/scrolling policy.
   * Rebuild only resident ranges and retain the unloaded geometry and folds. */
  refresh(branch: readonly SessionEntry[]): HistoryTransition | undefined {
    const view = this.viewport;
    if (!view) return undefined;
    const before = this.batches.map(batch => ({ batch, top: batch.top, rows: batch.rows,
      anchors: batch.loaded ? this.componentAnchors(batch, view.width) : undefined }));
    this.branch = branch;
    this.batches.at(-1)!.end = branch.length;
    this.options.project(this.entries());
    for (const batch of this.batches) if (batch.loaded) {
      batch.components = this.options.draw(batch.start, batch.end);
      this.measure(batch, view.width, true);
    }
    return this.commit(view, before);
  }
  reconcile(): HistoryTransition | undefined {
    const view = this.viewport;
    if (!view?.idle) return undefined; // Native streaming/pending tools keep all their components.
    const first = this.batches[0]!;
    const prepend = (this.earlier || (!this.requested && view.top <= first.top)) && this.start > 0;
    const headerTop = first.top - (this.options.header?.render(view.width).length ?? 0);
    // A single native range cannot keep its text when insertion splits it, or
    // when it includes a changing/disappearing header. Prefix-only ranges stay.
    if (prepend && view.selected && view.selected.end >= headerTop && view.selected.start < first.top) return undefined;
    const before = this.batches.map(batch => ({ batch, top: batch.top, rows: batch.rows, anchors: batch.anchors }));
    let target = this.requested;
    if (prepend) {
      target = this.batch(historyWindowStart(this.branch, this.start), this.start);
    }
    const nearby = this.nearby(view);
    if (!target) target = this.batches.filter((batch, index) => !batch.loaded && nearby.has(index))
      .sort((a, b) => historyBatchDistance(a, view.top, view.top + view.height) - historyBatchDistance(b, view.top, view.top + view.height))[0];
    // Dragging across an unloaded gap must not add new text to the selection.
    if (!prepend && target && !target.loaded && view.selected
      && view.selected.start < target.top + target.rows && view.selected.end >= target.top) return undefined;
    const requestedKey = this.requestedKey;
    this.requested = undefined; this.requestedKey = undefined; this.earlier = false;
    if (prepend) this.batches.unshift(target!);
    let changed = false;
    if (target && !target.loaded) {
      target.loaded = true;
      this.options.project(this.entries());
      target.components = this.options.draw(target.start, target.end);
      target.anchor = undefined;
      target.anchors = undefined;
      this.measure(target, view.width, true);
      target.touched = ++this.clock;
      changed = true;
    }
    const protectedBatches = this.protected(view);
    if (target) protectedBatches.add(this.batches.indexOf(target));
    const evictions = historyEvictions(this.batches, view.top, view.top + view.height, protectedBatches);
    for (const index of evictions) {
      const batch = this.batches[index]!;
      let offset = 0;
      const spans: HistoryStickySpan[] = [];
      for (const component of batch.components!) {
        const measure = batch.measurements.get(component)!;
        if (measure.summary) {
          const key = historyComponentIdentity(component)?.key;
          spans.push({ summary: measure.summary, start: offset, end: offset + measure.rows, jump: () => this.requestBatch(batch, key) });
        }
        offset += measure.rows;
      }
      batch.anchor = new HistoryAnchor(batch.rows, spans, () => this.requestBatch(batch));
      // Keep only record/component IDs and local geometry, never rendered text
      // or components. These survive a width change while the batch is absent.
      batch.anchors = this.componentAnchors(batch, view.width).map(({ signature: _signature, ...anchor }) => anchor);
      batch.components = undefined;
      batch.loaded = false;
      changed = true;
    }
    if (!changed) return undefined;
    if (evictions.length) this.options.project(this.entries());
    for (const batch of this.batches) if (batch.loaded) this.measure(batch, view.width, true);
    const transition = this.commit(view, before);
    // Keep the viewport attached to the old transcript when loading from the
    // top; prefix selection coordinates still use the identity mapping above.
    if (prepend && view.top < before[0]!.top) {
      const old = before[0]!;
      transition.top = transition.mapRow(old.top) + view.top - old.top;
    }
    if (requestedKey && target?.loaded) {
      const anchor = this.componentAnchors(target, view.width).find(item => item.key === requestedKey);
      if (anchor) transition.top = target.top + anchor.top;
    }
    return transition;
  }
  private componentAnchors(batch: Batch, width: number): ComponentAnchor[] {
    let top = 0;
    const ordinals = new Map<unknown, number>();
    const result: ComponentAnchor[] = [];
    for (const component of batch.components ?? []) {
      const lines = component.render(width), identity = historyComponentIdentity(component), key = identity?.key;
      const signature = lines.join("\n");
      const kind = component.constructor;
      const ordinal = ordinals.get(kind) ?? 0;
      if (!identity?.presentation) ordinals.set(kind, ordinal + 1);
      if (stripTerminalSequences(signature).trim()) result.push({ key, kind, ordinal, signature: key ? undefined : signature, top, rows: lines.length });
      top += lines.length;
    }
    return result;
  }
  private commit(view: HistoryViewport, before: BatchPosition[]): HistoryTransition {
    this.options.changed(this.start);
    this.options.chat.children.splice(0, this.options.chat.children.length, ...this.roots());
    this.positions(view);
    const rebuilt = new Map<Batch, ComponentAnchor[]>();
    for (const old of before) if (old.anchors) rebuilt.set(old.batch, old.batch.loaded ? this.componentAnchors(old.batch, view.width) : old.batch.anchors ?? []);
    const mapRow = (row: number): number => {
      const owner = before.find(record => row >= record.top && row < record.top + record.rows);
      if (!owner) {
        const oldEnd = before.at(-1);
        const end = this.batches.at(-1)!;
        // Document/chat prefixes and header are not part of the first batch.
        return oldEnd && row >= oldEnd.top + oldEnd.rows ? row + end.top + end.rows - oldEnd.top - oldEnd.rows : row;
      }
      if (owner.anchors?.length) {
        const relative = row - owner.top;
        const anchor = owner.anchors.find(item => relative >= item.top && relative < item.top + item.rows)
          ?? owner.anchors.find(item => item.top > relative) ?? owner.anchors.at(-1)!;
        const occurrence = owner.anchors.filter(item => item.kind === anchor.kind && item.signature === anchor.signature && item.top < anchor.top).length;
        const next = rebuilt.get(owner.batch) ?? [];
        const matched = (anchor.key ? next.find(item => item.key === anchor.key) : undefined)
          ?? (anchor.signature ? next.filter(item => item.kind === anchor.kind && item.signature === anchor.signature)[occurrence] : undefined)
          ?? next.find(item => item.kind === anchor.kind && item.ordinal === anchor.ordinal);
        if (matched) return owner.batch.top + matched.top + Math.min(relative - anchor.top, Math.max(0, matched.rows - 1));
      }
      return owner.batch.top + Math.min(row - owner.top, Math.max(0, owner.batch.rows - 1));
    };
    const end = this.batches.at(-1)!;
    return { top: mapRow(view.top), rows: end.top + end.rows, mapRow };
  }
}
