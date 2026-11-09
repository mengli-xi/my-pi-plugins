import { type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { BranchSummaryMessageComponent, CompactionSummaryMessageComponent, CustomMessageComponent, SkillInvocationMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

export const HISTORY_RECORD_LIMIT = 2000;
export const HISTORY_ROW_LIMIT = 10000;

export interface HistoryStickySpan { summary: string; start: number; end: number; jump?: () => void }
export interface HistoryComponentIdentity { key: string; recordId: string; presentation?: boolean }
const componentIdentities = new WeakMap<Component, HistoryComponentIdentity>();
export function historyComponentIdentity(component: Component): HistoryComponentIdentity | undefined { return componentIdentities.get(component); }
/** Bind roots to the session record captured at the existing native append seam.
 * Class ordinals are local to a record, so optional spacers/markers cannot shift
 * the identity of another message or of that record's user/tool component. */
export function identifyHistoryComponents(components: readonly Component[], sources: ReadonlyMap<Component, { recordId: string; message: number; presentation?: boolean }>): void {
  let source: { recordId: string; message: number; presentation?: boolean } | undefined;
  const ordinals = new Map<string, number>();
  for (const component of components) {
    source = sources.get(component) ?? source;
    if (!source) continue;
    const base = `${source.recordId}:${source.message}:${component.constructor.name}`;
    const ordinal = ordinals.get(base) ?? 0; ordinals.set(base, ordinal + 1);
    componentIdentities.set(component, { key: `${base}:${ordinal}`, recordId: source.recordId, presentation: source.presentation });
  }
}
const HISTORY_ANCHOR = Symbol.for("pi.claude-style.history-anchor.v1");

/** Geometry only: no transcript text participates in rendering/search/copy. */
export class HistoryAnchor implements Component {
  readonly [HISTORY_ANCHOR] = 1;
  readonly stickySpans: readonly HistoryStickySpan[];
  private readonly lines: string[];
  private readonly request: () => void;
  constructor(rows: number, spans: readonly HistoryStickySpan[], request: () => void) {
    this.lines = Array.from({ length: rows }, () => "");
    this.stickySpans = spans;
    this.request = request;
  }
  render(): string[] { return this.lines; }
  invalidate(): void {}
  handleMouse(event: TuiMouseEvent) {
    // An unloaded gap cannot be a text-selection origin. Load it first.
    if (event.type === "press" || event.type === "click") { this.request(); return { handled: true }; }
    return undefined;
  }
}
/** Source/jiti and bundled child graphs may have different class identities. */
export function isHistoryAnchor(component: Component): component is HistoryAnchor {
  try {
    const candidate = component as HistoryAnchor;
    return candidate[HISTORY_ANCHOR] === 1 && Array.isArray(candidate.stickySpans)
      && candidate.stickySpans.every(span => typeof span.summary === "string" && Number.isFinite(span.start) && Number.isFinite(span.end));
  } catch { return false; } // Foreign renderer proxies need not accept our metadata key.
}

export interface ResidentHistoryBatch {
  start: number;
  end: number;
  rows: number;
  top: number;
  loaded: boolean;
  touched: number;
}
export function historyBatchDistance(batch: ResidentHistoryBatch, top: number, bottom: number): number {
  return batch.top + batch.rows < top ? top - batch.top - batch.rows : batch.top > bottom ? batch.top - bottom : 0;
}
/** Complete farthest batches leave first; protected batches may exceed limits. */
export function historyEvictions(
  batches: readonly ResidentHistoryBatch[], top: number, bottom: number, protectedBatches: ReadonlySet<number>,
  recordLimit = HISTORY_RECORD_LIMIT, rowLimit = HISTORY_ROW_LIMIT,
): number[] {
  let records = 0, rows = 0;
  for (const batch of batches) if (batch.loaded) { records += batch.end - batch.start; rows += batch.rows; }
  const candidates = batches.map((batch, index) => ({ batch, index }))
    .filter(({ batch, index }) => batch.loaded && !protectedBatches.has(index) && historyBatchDistance(batch, top, bottom) > 0)
    .sort((a, b) => historyBatchDistance(b.batch, top, bottom) - historyBatchDistance(a.batch, top, bottom) || a.batch.touched - b.batch.touched);
  const result: number[] = [];
  for (const { batch, index } of candidates) {
    if (records <= recordLimit && rows <= rowLimit) break;
    result.push(index); records -= batch.end - batch.start; rows -= batch.rows;
  }
  return result;
}

/** Record only public Pi expansion methods, never private expanded fields.
 * Keys use captured record identities (class ordinal fallback for foreign roots).
 * Presentation markers never consume a real message ordinal. Global Ctrl+O changes
 * clear these local overrides using public ui.getToolsExpanded(). */
export function rememberHistoryExpansion(components: readonly Component[], saved: Map<string, boolean>, installed = new WeakSet<Component>()): void {
  const ordinals = new Map<string, number>();
  for (const component of components) {
    const identity = historyComponentIdentity(component);
    if (identity?.presentation) continue;
    let kind: string | undefined;
    if (component instanceof ToolExecutionComponent) kind = "tool";
    else if (component instanceof CompactionSummaryMessageComponent) kind = "compaction";
    else if (component instanceof BranchSummaryMessageComponent) kind = "branch";
    else if (component instanceof SkillInvocationMessageComponent) kind = "skill";
    else if (component instanceof CustomMessageComponent) kind = "message";
    if (!kind) continue;
    const index = ordinals.get(kind) ?? 0; ordinals.set(kind, index + 1);
    const key = identity?.key ?? `${kind}:${index}`;
    if (installed.has(component)) continue;
    installed.add(component);
    const expandable = component as ToolExecutionComponent;
    const original = expandable.setExpanded;
    expandable.setExpanded = function (value) { saved.set(key, value); original.call(this, value); };
    // A live component may predate its persisted record ID. Migrate its local
    // override on the first record-backed rebuild; markers never affect index.
    const previous = saved.get(key) ?? saved.get(`${kind}:${index}`);
    if (previous !== undefined) expandable.setExpanded(previous);
  }
}
