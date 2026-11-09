import type {
  CapturedResult,
  GroupStatus,
  ToolActivity,
  ToolGroup,
  ToolGroupSnapshot,
  ToolPresentationKind,
  ToolStatus,
} from "./types.ts";
import type { Component } from "@earendil-works/pi-tui";
import type { AssistantContentItem } from "./group-boundaries.ts";

export interface GroupStoreOptions {
  maxGroups: number;
  /** Total bytes retained by captured result text, details, and image payloads. */
  maxCapturedBytes?: number;
  now?: () => number;
  invalidationsEnabled?: boolean;
  /** Coalesce repeated renderer invalidations into one microtask. */
  batchInvalidations?: boolean;
}

export interface GroupStoreBulkWriter {
  start(
    toolCallId: string,
    toolName: string,
    args: unknown,
    timestamp?: number,
    presentation?: Exclude<ToolPresentationKind, "native">,
    parentToolCallId?: string,
  ): void;
  ensure(
    toolCallId: string,
    toolName: string,
    args: unknown,
    timestamp?: number,
    presentation?: Exclude<ToolPresentationKind, "native">,
    parentToolCallId?: string,
  ): void;
  end(
    toolCallId: string,
    result: CapturedResult,
    status: Extract<ToolStatus, "completed" | "failed" | "cancelled">,
    timestamp?: number,
    durationMs?: number,
  ): void;
  closeBoundary(): void;
}

interface GroupCounts {
  running: number;
  failed: number;
  cancelled: number;
}

export class GroupStore {
  private readonly groups: ToolGroup[] = [];
  private readonly groupById = new Map<string, ToolGroup>();
  private readonly groupIndexById = new Map<string, number>();
  private readonly activityById = new Map<string, ToolActivity>();
  private readonly activeActivityIds = new Set<string>();
  private readonly groupCounts = new Map<string, GroupCounts>();
  // Pi creates a fresh context.invalidate closure every time a tool component
  // redraws. Keeping all of them is both unnecessary (they target the same
  // ToolExecutionComponent) and unsafe: calling an old invalidator redraws the
  // component, which registers another closure while the collection is being
  // iterated. Retain only the latest callback for each tool call.
  private readonly invalidators = new Map<string, () => void>();
  // Presentation references only. Pi's result component owns each row and its
  // images; the store neither copies payloads nor extends their lifetime.
  private readonly imageRows = new Map<string, WeakRef<Component>>();
  private readonly groupSubscribers = new Map<
    string,
    Set<(snapshot: ToolGroupSnapshot | undefined) => void>
  >();
  // Snapshots are rebuilt on every frame by every visible row, so each group
  // keeps the last one it handed out and re-uses it until it actually changes.
  private readonly snapshots = new Map<
    string,
    { version: number; snapshot: ToolGroupSnapshot }
  >();
  private currentGroup: ToolGroup | undefined;
  private message: { carry: ToolGroup | undefined } | undefined;
  private nextId = 1;
  private storeVersion = 0;
  private invalidationSuppressionDepth = 0;
  private invalidationsEnabled: boolean;
  private readonly now: () => number;
  private readonly options: GroupStoreOptions;
  private capturedBytes = 0;
  private unprunedGroups = 0;
  private pruneCursor = 0;
  private payloadGroupCursor = 0;
  private payloadActivityCursor = 0;
  private bulkDepth = 0;
  private readonly pendingInvalidationIds = new Set<string>();
  private invalidationScheduled = false;
  private invalidationGeneration = 0;

  constructor(options: GroupStoreOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.invalidationsEnabled = options.invalidationsEnabled ?? true;
  }

  start(
    toolCallId: string,
    toolName: string,
    args: unknown,
    timestamp = this.now(),
    presentation: Exclude<ToolPresentationKind, "native"> = "grouped",
    parentToolCallId?: string,
  ): ToolGroupSnapshot {
    const group = this.startMutation(
      toolCallId,
      toolName,
      args,
      timestamp,
      presentation,
      parentToolCallId,
    );
    this.maintainBudgets();
    return this.snapshot(group);
  }

  private startMutation(
    toolCallId: string,
    toolName: string,
    args: unknown,
    timestamp: number,
    presentation: Exclude<ToolPresentationKind, "native">,
    parentToolCallId?: string,
  ): ToolGroup {
    const existing = this.activityById.get(toolCallId);
    if (existing) {
      this.replacePayload(existing, () => { existing.args = args; });
      const group = this.findGroup(existing.groupId);
      if (!group) throw new Error(`Missing tool group: ${existing.groupId}`);
      group.updatedAt = Math.max(group.updatedAt, timestamp);
      this.changed(group);
      return group;
    }

    let target: ToolGroup;
    if (parentToolCallId) {
      const parent = this.activityById.get(parentToolCallId);
      const parentGroup = parent && this.findGroup(parent.groupId);
      if (!parentGroup) throw new Error(`Missing parent tool group: ${parentToolCallId}`);
      parentToolCallId = parent.parentToolCallId ?? parentToolCallId;
      target = parentGroup;
    } else if (presentation !== "grouped") {
      this.closeBoundary();
      target = this.createGroup(toolCallId, timestamp, presentation);
    } else {
      if (!this.currentGroup) {
        this.currentGroup = this.createGroup(
          toolCallId,
          timestamp,
          "grouped",
        );
      } else if (this.currentGroup.status !== "collecting") {
        this.currentGroup.status = "collecting";
      }
      target = this.currentGroup;
    }

    const activity: ToolActivity = {
      id: toolCallId,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      groupId: target.id,
      toolName,
      args,
      status: "running",
      startedAt: timestamp,
    };
    target.activities.push(activity);
    this.activeActivityIds.add(toolCallId);
    const counts = this.groupCounts.get(target.id);
    if (counts) counts.running++;
    this.capturedBytes += this.activityBytes(activity);
    target.updatedAt = timestamp;
    this.activityById.set(toolCallId, activity);
    this.changed(target);
    return target;
  }

  ensure(
    toolCallId: string,
    toolName: string,
    args: unknown,
    timestamp = this.now(),
    presentation: Exclude<ToolPresentationKind, "native"> = "grouped",
    parentToolCallId?: string,
  ): ToolGroupSnapshot {
    const activity = this.activityById.get(toolCallId);
    return activity
      ? this.snapshotByActivity(activity)
      : this.start(toolCallId, toolName, args, timestamp, presentation, parentToolCallId);
  }

  update(toolCallId: string, args: unknown, result?: CapturedResult): void {
    const activity = this.activityById.get(toolCallId);
    if (!activity || activity.status !== "running") return;
    this.replacePayload(activity, () => {
      activity.args = args;
      if (result) activity.result = result;
    });
    const group = this.findGroup(activity.groupId);
    if (!group) return;
    group.updatedAt = this.now();
    this.changed(group);
    this.maintainBudgets();
  }

  end(
    toolCallId: string,
    result: CapturedResult,
    status: Extract<ToolStatus, "completed" | "failed" | "cancelled">,
    timestamp = this.now(),
    durationMs?: number,
  ): void {
    this.endMutation(toolCallId, result, status, timestamp, durationMs);
    this.maintainBudgets();
  }

  private endMutation(
    toolCallId: string,
    result: CapturedResult,
    status: Extract<ToolStatus, "completed" | "failed" | "cancelled">,
    timestamp: number,
    durationMs?: number,
  ): void {
    const activity = this.activityById.get(toolCallId);
    if (!activity || activity.status !== "running") return;
    this.replacePayload(activity, () => { activity.result = result; });
    activity.status = status;
    this.activeActivityIds.delete(toolCallId);
    const counts = this.groupCounts.get(activity.groupId);
    if (counts) {
      counts.running = Math.max(0, counts.running - 1);
      if (status === "failed") counts.failed++;
      else if (status === "cancelled") counts.cancelled++;
    }
    activity.endedAt = timestamp;
    if (durationMs !== undefined) activity.durationMs = durationMs;
    const group = this.findGroup(activity.groupId);
    if (!group) return;
    group.updatedAt = activity.endedAt;
    this.updateTerminalStatus(group);
    this.changed(group);
  }

  closeBoundary(): void {
    const group = this.currentGroup;
    this.currentGroup = undefined;
    if (!group) return;
    this.updateTerminalStatus(group);
    this.changed(group);
  }

  has(toolCallId: string): boolean {
    return this.activityById.has(toolCallId);
  }

  /** The group a new assistant message's leading calls may continue, as in history replay. */
  beginAssistantMessage(): void {
    this.message = { carry: this.currentGroup };
  }

  /**
   * Lay out the current assistant message's tracked calls exactly as history
   * replay lays out the same content: calls before the first boundary continue
   * the group open when the message began, each later run of grouped calls
   * gets its own group, and each standalone call gets one. The layout is
   * rebuilt from content order every time, so neither the order calls were
   * registered in nor a presentation that changed while arguments streamed can
   * leave this message grouped differently from history. Groups are reused by
   * their calls so rows and open overlays keep their identity.
   */
  alignAssistantMessage(items: readonly AssistantContentItem[]): void {
    const message = this.message;
    if (!message) return;
    const carry = message.carry && this.groupById.get(message.carry.id) === message.carry ? message.carry : undefined;
    for (const item of items) {
      if (item.kind === "boundary" && item.callId) this.dropActivity(item.callId, carry);
    }

    interface Slot { presentation: Exclude<ToolPresentationKind, "native">; roots: ToolActivity[]; carry: boolean }
    const slots: Slot[] = [];
    let open: Slot | undefined = carry ? { presentation: "grouped", roots: [], carry: true } : undefined;
    for (const item of items) {
      if (item.kind === "boundary") {
        open = undefined;
        continue;
      }
      const activity = this.activityById.get(item.id);
      if (item.presentation !== "grouped") {
        if (activity && !activity.parentToolCallId) slots.push({ presentation: item.presentation, roots: [activity], carry: false });
        open = undefined;
        continue;
      }
      // An untracked grouped call joins the open group when it is tracked.
      if (!activity || activity.parentToolCallId) continue;
      open ??= { presentation: "grouped", roots: [], carry: false };
      if (open.roots.length === 0) slots.push(open);
      open.roots.push(activity);
    }

    const roots = new Set(slots.flatMap((slot) => slot.roots.map((root) => root.id)));
    const ofMessage = (activity: ToolActivity) => roots.has(activity.parentToolCallId ?? activity.id);
    const owned = new Set<ToolGroup>();
    for (const id of roots) {
      const group = this.findGroup(this.activityById.get(id)!.groupId);
      if (group && group !== carry) owned.add(group);
    }
    // Only this message's calls can share a group created after it began.
    for (const group of owned) if (!group.activities.every(ofMessage)) return;

    const children = new Map<string, ToolActivity[]>();
    for (const group of carry ? [carry, ...owned] : owned) {
      for (const activity of group.activities) {
        if (!activity.parentToolCallId || !roots.has(activity.parentToolCallId)) continue;
        const list = children.get(activity.parentToolCallId) ?? [];
        list.push(activity);
        children.set(activity.parentToolCallId, list);
      }
    }
    const members = (slot: Slot) => slot.roots.flatMap((root) => [root, ...(children.get(root.id) ?? [])]);

    const carryIndex = carry ? this.groupIndexById.get(carry.id)! : -1;
    const removed = [...owned].map((group) => this.groupIndexById.get(group.id)!).sort((a, b) => b - a);
    let insertAt = carry ? carryIndex + 1 : removed.at(-1) ?? this.groups.length;
    for (const index of removed) this.groups.splice(index, 1);
    insertAt = Math.min(insertAt, this.groups.length);
    if (carry) carry.activities = carry.activities.filter((activity) => !ofMessage(activity));

    const reusable = new Set(owned);
    const placed: ToolGroup[] = [];
    for (const slot of slots) {
      const activities = members(slot);
      let group: ToolGroup | undefined;
      if (slot.carry) group = carry!;
      else {
        group = [...reusable].find((candidate) => candidate.activities.includes(slot.roots[0]!)) ??
          [...reusable].find((candidate) => candidate.activities.some((activity) => slot.roots.includes(activity)));
        if (group) reusable.delete(group);
        else group = this.registerGroup(slot.roots[0]!.id, slot.roots[0]!.startedAt, slot.presentation);
        group.anchorToolCallId = slot.roots[0]!.id;
        group.presentation = slot.presentation;
        group.activities = [];
        placed.push(group);
      }
      for (const activity of activities) activity.groupId = group.id;
      group.activities.push(...activities);
      group.updatedAt = Math.max(group.updatedAt, ...activities.map((activity) => activity.endedAt ?? activity.startedAt));
    }
    this.groups.splice(insertAt, 0, ...placed);
    for (const group of reusable) this.unregisterGroup(group);
    const firstTouched = carry ? carryIndex : Math.min(insertAt, removed.at(-1) ?? insertAt);
    for (let i = firstTouched; i < this.groups.length; i++) this.groupIndexById.set(this.groups[i]!.id, i);

    const lastSlot = open;
    this.currentGroup = lastSlot ? (lastSlot.carry ? carry : this.findGroup(lastSlot.roots[0]!.groupId)) : undefined;
    for (const group of carry ? [carry, ...placed] : placed) {
      const counts = this.countActivities(group);
      this.groupCounts.set(group.id, counts);
      if (counts.running > 0) group.status = "collecting";
      else this.updateTerminalStatus(group);
    }

    // Rescan budgets from the first touched group; both scans skip what they
    // already released, so moving work back only costs a short rescan.
    if (this.pruneCursor > firstTouched) this.pruneCursor = firstTouched;
    if (this.payloadGroupCursor >= firstTouched) {
      this.payloadGroupCursor = firstTouched;
      this.payloadActivityCursor = 0;
    }
    for (const group of carry ? [carry, ...placed] : placed) this.changed(group);
    this.maintainBudgets();
  }

  finish(status: Exclude<GroupStatus, "collecting">): void {
    const timestamp = this.now();
    // Only groups that actually settle here are redrawn. Invalidating every
    // group instead made ending or interrupting a run re-render the whole
    // transcript, which is what an interrupt used to stall on.
    const touched = new Set<ToolGroup>();
    for (const id of this.activeActivityIds) {
      const activity = this.activityById.get(id);
      if (!activity) continue;
      const next = status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed";
      activity.status = next;
      activity.endedAt = timestamp;
      const counts = this.groupCounts.get(activity.groupId);
      if (counts) {
        counts.running = Math.max(0, counts.running - 1);
        if (next === "failed") counts.failed++;
        else if (next === "cancelled") counts.cancelled++;
      }
      const group = this.findGroup(activity.groupId);
      if (group) touched.add(group);
    }
    this.activeActivityIds.clear();
    if (this.currentGroup) touched.add(this.currentGroup);
    for (const group of touched) {
      group.status = status;
      group.updatedAt = timestamp;
      this.changed(group);
    }
  }

  registerRenderer(toolCallId: string, invalidate: () => void): void {
    this.invalidators.set(toolCallId, invalidate);
  }

  unregisterRenderer(toolCallId: string): void {
    this.invalidators.delete(toolCallId);
    this.imageRows.delete(toolCallId);
  }

  retainRenderers(toolCallIds: ReadonlySet<string>): void {
    for (const id of this.invalidators.keys()) if (!toolCallIds.has(id)) this.invalidators.delete(id);
    for (const id of this.imageRows.keys()) if (!toolCallIds.has(id)) this.imageRows.delete(id);
  }

  registerImageRow(toolCallId: string, row: Component): void {
    this.imageRows.set(toolCallId, new WeakRef(row));
  }

  unregisterImageRow(toolCallId: string): void {
    this.imageRows.delete(toolCallId);
  }

  /** Native tool order, independent of the order results arrive or restore. */
  imageRowsFor(toolCallId: string): { toolCallId: string; row: Component }[] {
    const group = this.getByToolCallId(toolCallId);
    if (!group) return [];
    return group.activities.flatMap((activity) => {
      const row = this.imageRows.get(activity.id)?.deref();
      return row ? [{ toolCallId: activity.id, row }] : [];
    });
  }

  getByToolCallId(toolCallId: string): ToolGroupSnapshot | undefined {
    const activity = this.activityById.get(toolCallId);
    return activity ? this.snapshotByActivity(activity) : undefined;
  }

  getActivity(toolCallId: string): ToolActivity | undefined {
    return this.getByToolCallId(toolCallId)?.activities.find(
      (activity) => activity.id === toolCallId,
    );
  }

  /**
   * Counts every mutation in the store. Row components render on every frame,
   * including while the user is only typing or scrolling, so they cache their
   * lines against this and recompute nothing until something really changed.
   */
  version(): number {
    return this.storeVersion;
  }

  /** Current retained captured-result payload size, measured as UTF-8 bytes. */
  capturedPayloadBytes(): number {
    return this.capturedBytes;
  }

  getById(groupId: string): ToolGroupSnapshot | undefined {
    const group = this.findGroup(groupId);
    return group ? this.snapshot(group) : undefined;
  }

  subscribe(
    groupId: string,
    listener: (snapshot: ToolGroupSnapshot | undefined) => void,
  ): () => void {
    const listeners = this.groupSubscribers.get(groupId) ?? new Set();
    listeners.add(listener);
    this.groupSubscribers.set(groupId, listeners);
    try {
      listener(this.getById(groupId));
    } catch {
      // Subscribers are observational. A panel that fails its initial paint
      // must not make opening it mutate or reject the tool lifecycle.
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.groupSubscribers.delete(groupId);
    };
  }

  list(): ToolGroupSnapshot[] {
    return this.groups.map((group) => this.snapshot(group));
  }

  groupCount(): number {
    return this.groups.length;
  }

  latest(): ToolGroupSnapshot | undefined {
    const group = this.groups.at(-1);
    return group ? this.snapshot(group) : undefined;
  }

  listInspectable(): ToolGroupSnapshot[] {
    return this.groups
      .filter((group) => group.presentation !== "question" && !group.pruned)
      .map((group) => this.snapshot(group));
  }

  latestInspectable(): ToolGroupSnapshot | undefined {
    const group = [...this.groups]
      .reverse()
      .find((candidate) =>
        candidate.presentation !== "question" && !candidate.pruned
      );
    return group ? this.snapshot(group) : undefined;
  }

  clear(options: { preserveInvalidators?: boolean } = {}): void {
    for (const listeners of this.groupSubscribers.values()) {
      for (const listener of listeners) {
        try {
          listener(undefined);
        } catch {
          // A retiring overlay must not block store cleanup.
        }
      }
    }
    this.groupSubscribers.clear();
    this.groups.length = 0;
    this.groupById.clear();
    this.groupIndexById.clear();
    this.activityById.clear();
    this.activeActivityIds.clear();
    this.groupCounts.clear();
    this.snapshots.clear();
    if (!options.preserveInvalidators) {
      this.invalidators.clear();
      this.imageRows.clear();
    }
    this.currentGroup = undefined;
    this.message = undefined;
    this.nextId = 1;
    this.capturedBytes = 0;
    this.unprunedGroups = 0;
    this.pruneCursor = 0;
    this.payloadGroupCursor = 0;
    this.payloadActivityCursor = 0;
    this.bulkDepth = 0;
    this.pendingInvalidationIds.clear();
    this.invalidationScheduled = false;
    this.invalidationGeneration++;
    this.storeVersion++;
  }

  invalidateAll(): void {
    if (!this.invalidationsEnabled || this.invalidationSuppressionDepth > 0) {
      return;
    }
    for (const invalidate of this.invalidators.values()) {
      try {
        invalidate();
      } catch {
        // Stale renderer invalidators are harmless during history rebuilds.
      }
    }
  }

  withoutInvalidation<T>(operation: () => T): T {
    this.invalidationSuppressionDepth++;
    try {
      return operation();
    } finally {
      this.invalidationSuppressionDepth--;
    }
  }

  /** Restore history without snapshots, redraws, or per-entry budget scans. */
  bulkRestore<T>(operation: (writer: GroupStoreBulkWriter) => T): T {
    this.bulkDepth++;
    this.invalidationSuppressionDepth++;
    const writer: GroupStoreBulkWriter = {
      start: (id, name, args, timestamp = this.now(), presentation = "grouped", parentToolCallId) => {
        this.startMutation(id, name, args, timestamp, presentation, parentToolCallId);
      },
      ensure: (id, name, args, timestamp = this.now(), presentation = "grouped", parentToolCallId) => {
        if (!this.activityById.has(id)) {
          this.startMutation(id, name, args, timestamp, presentation, parentToolCallId);
        }
      },
      end: (id, result, status, timestamp = this.now(), durationMs) => {
        this.endMutation(id, result, status, timestamp, durationMs);
      },
      closeBoundary: () => this.closeBoundary(),
    };
    try {
      return operation(writer);
    } finally {
      this.invalidationSuppressionDepth--;
      this.bulkDepth--;
      if (this.bulkDepth === 0) this.maintainBudgets();
    }
  }

  setInvalidationsEnabled(enabled: boolean): void {
    this.invalidationsEnabled = enabled;
  }

  private updateTerminalStatus(group: ToolGroup): void {
    const counts = this.groupCounts.get(group.id);
    if (counts && counts.running > 0) return;
    if (counts && counts.failed > 0) {
      group.status = "failed";
    } else if (counts && counts.cancelled > 0) {
      group.status = "cancelled";
    } else {
      group.status = "completed";
    }
  }

  private createGroup(
    toolCallId: string,
    timestamp: number,
    presentation: Exclude<ToolPresentationKind, "native">,
  ): ToolGroup {
    const group = this.registerGroup(toolCallId, timestamp, presentation);
    this.groups.push(group);
    this.groupIndexById.set(group.id, this.groups.length - 1);
    return group;
  }

  /** A new group known to the store but not yet placed in `groups`. */
  private registerGroup(
    toolCallId: string,
    timestamp: number,
    presentation: Exclude<ToolPresentationKind, "native">,
  ): ToolGroup {
    const group: ToolGroup = {
      id: `group-${this.nextId++}`,
      anchorToolCallId: toolCallId,
      presentation,
      activities: [],
      status: "collecting",
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 0,
    };
    this.groupById.set(group.id, group);
    this.groupCounts.set(group.id, { running: 0, failed: 0, cancelled: 0 });
    this.unprunedGroups++;
    this.storeVersion++;
    return group;
  }

  /** A call now rendered natively is not tracked; forget its provisional activity. */
  private dropActivity(toolCallId: string, keep: ToolGroup | undefined): void {
    const activity = this.activityById.get(toolCallId);
    if (!activity || activity.parentToolCallId) return;
    const group = this.findGroup(activity.groupId);
    const dropped = group?.activities.filter((candidate) =>
      candidate === activity || candidate.parentToolCallId === toolCallId) ?? [activity];
    for (const candidate of dropped) {
      this.capturedBytes -= this.activityBytes(candidate);
      this.activityById.delete(candidate.id);
      this.activeActivityIds.delete(candidate.id);
    }
    if (!group) return;
    group.activities = group.activities.filter((candidate) => !dropped.includes(candidate));
    this.groupCounts.set(group.id, this.countActivities(group));
    if (group.activities.length > 0 || group === keep) {
      this.changed(group);
      return;
    }
    const index = this.groupIndexById.get(group.id)!;
    this.groups.splice(index, 1);
    this.unregisterGroup(group);
    for (let i = index; i < this.groups.length; i++) this.groupIndexById.set(this.groups[i]!.id, i);
    if (this.currentGroup === group) this.currentGroup = undefined;
    if (this.pruneCursor > index) this.pruneCursor--;
    if (this.payloadGroupCursor > index) this.payloadGroupCursor--;
    else if (this.payloadGroupCursor === index) this.payloadActivityCursor = 0;
  }

  private unregisterGroup(group: ToolGroup): void {
    this.groupById.delete(group.id);
    this.groupIndexById.delete(group.id);
    this.groupCounts.delete(group.id);
    this.snapshots.delete(group.id);
    if (!group.pruned) this.unprunedGroups = Math.max(0, this.unprunedGroups - 1);
    const listeners = this.groupSubscribers.get(group.id);
    this.groupSubscribers.delete(group.id);
    for (const listener of listeners ?? []) {
      try {
        listener(undefined);
      } catch {
        // A retiring overlay must not block store cleanup.
      }
    }
    this.storeVersion++;
  }

  private countActivities(group: ToolGroup): GroupCounts {
    const counts: GroupCounts = { running: 0, failed: 0, cancelled: 0 };
    for (const activity of group.activities) {
      if (activity.status === "running") counts.running++;
      else if (activity.status === "failed") counts.failed++;
      else if (activity.status === "cancelled") counts.cancelled++;
    }
    return counts;
  }

  private snapshotByActivity(activity: ToolActivity): ToolGroupSnapshot {
    const group = this.findGroup(activity.groupId);
    if (!group) throw new Error(`Missing tool group: ${activity.groupId}`);
    return this.snapshot(group);
  }

  private snapshot(group: ToolGroup): ToolGroupSnapshot {
    const cached = this.snapshots.get(group.id);
    if (cached && cached.version === group.version) return cached.snapshot;
    let failureCount = 0;
    let runningCount = 0;
    for (const activity of group.activities) {
      if (activity.status === "failed") failureCount++;
      else if (activity.status === "running") runningCount++;
    }
    const snapshot: ToolGroupSnapshot = {
      id: group.id,
      anchorToolCallId: group.anchorToolCallId,
      presentation: group.presentation,
      activities: group.activities.map((activity) => ({
        ...activity,
        result: activity.result ? { ...activity.result } : undefined,
      })),
      status: group.status,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      failureCount,
      runningCount,
      pruned: group.pruned === true,
    };
    this.snapshots.set(group.id, { version: group.version, snapshot });
    return snapshot;
  }

  /** Marks a group changed, dropping the cached snapshot rendered from it. */
  private touch(group: ToolGroup): void {
    group.version++;
    this.storeVersion++;
  }

  private findGroup(groupId: string): ToolGroup | undefined {
    return this.groupById.get(groupId);
  }

  /** One mutation: drop the cached snapshot, then redraw the affected rows. */
  private changed(group: ToolGroup): void {
    this.touch(group);
    this.invalidateGroup(group);
    const listeners = this.groupSubscribers.get(group.id);
    if (!listeners?.size) return;
    const snapshot = this.snapshot(group);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Overlay rendering is observational; a stale view cannot fail a tool mutation.
      }
    }
  }

  private serializedBytes(value: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    } catch {
      return Buffer.byteLength(String(value), "utf8");
    }
  }

  private activityBytes(activity: ToolActivity): number {
    return this.serializedBytes(activity.args) +
      (activity.result
        ? Buffer.byteLength(activity.result.text, "utf8") +
          this.serializedBytes(activity.result.details)
        : 0);
  }

  private replacePayload(
    activity: ToolActivity,
    mutate: () => void,
    trackGrowth = true,
  ): void {
    const before = this.activityBytes(activity);
    this.capturedBytes -= before;
    mutate();
    const after = this.activityBytes(activity);
    this.capturedBytes += after;
    if (trackGrowth && after > before) this.rewindPayloadCursor(activity);
  }

  private rewindPayloadCursor(activity: ToolActivity): void {
    const groupIndex = this.groupIndexById.get(activity.groupId);
    if (groupIndex === undefined || groupIndex > this.payloadGroupCursor) return;
    const group = this.groups[groupIndex];
    const activityIndex = group?.activities.indexOf(activity) ?? -1;
    if (activityIndex < 0) return;
    if (
      groupIndex < this.payloadGroupCursor ||
      activityIndex < this.payloadActivityCursor
    ) {
      this.payloadGroupCursor = groupIndex;
      this.payloadActivityCursor = activityIndex;
    }
  }

  private maintainBudgets(): void {
    if (this.bulkDepth > 0) return;
    this.prune();
    this.enforceCapturedBudget();
  }

  /**
   * Release oldest captured results until the independent byte budget is met.
   * Rows and metadata remain stable; only overlay payloads are discarded.
   */
  private enforceCapturedBudget(): void {
    const budget = this.options.maxCapturedBytes ?? Number.POSITIVE_INFINITY;
    if (this.capturedBytes <= budget) return;
    while (
      this.capturedBytes > budget &&
      this.payloadGroupCursor < this.groups.length
    ) {
      const group = this.groups[this.payloadGroupCursor]!;
      let touched = false;
      while (
        this.capturedBytes > budget &&
        this.payloadActivityCursor < group.activities.length
      ) {
        const activity = group.activities[this.payloadActivityCursor++]!;
        const result = activity.result;
        if (
          (!result || result.text.length === 0) &&
          activity.args === undefined
        ) continue;
        this.replacePayload(activity, () => {
          // `undefined` is the only zero-byte representation under
          // `serializedBytes`; replacing with `{}` left two bytes per activity
          // and allowed a long history to exceed a small configured budget.
          activity.args = undefined;
          if (result) {
            activity.result = {
              text: "",
              truncated: true,
              isError: result.isError,
              imageSummary: result.imageSummary,
            };
          }
        }, false);
        touched = true;
      }
      if (touched) {
        this.markPruned(group);
        this.changed(group);
      }
      if (this.payloadActivityCursor >= group.activities.length) {
        this.payloadGroupCursor++;
        this.payloadActivityCursor = 0;
      }
    }
  }

  private invalidateGroup(group: ToolGroup): void {
    if (!this.invalidationsEnabled || this.invalidationSuppressionDepth > 0) {
      return;
    }
    if (this.options.batchInvalidations) {
      for (const activity of group.activities) this.pendingInvalidationIds.add(activity.id);
      this.scheduleInvalidationFlush();
      return;
    }
    for (const activity of group.activities) {
      const invalidate = this.invalidators.get(activity.id);
      if (!invalidate) continue;
      try {
        invalidate();
      } catch {
        // Stale renderer invalidators are harmless during reload/history rebuild.
      }
    }
  }

  private scheduleInvalidationFlush(): void {
    if (this.invalidationScheduled) return;
    this.invalidationScheduled = true;
    const generation = this.invalidationGeneration;
    queueMicrotask(() => {
      if (generation !== this.invalidationGeneration) return;
      this.invalidationScheduled = false;
      const ids = [...this.pendingInvalidationIds];
      this.pendingInvalidationIds.clear();
      if (!this.invalidationsEnabled || this.invalidationSuppressionDepth > 0) return;
      for (const id of ids) {
        try {
          this.invalidators.get(id)?.();
        } catch {
          // A stale component cannot fail the event batch.
        }
      }
    });
  }

  /**
   * Pi keeps every historical row's component for the life of the session. A
   * dropped group would make its row render as zero lines, which changes the
   * transcript height above the fold and costs a full-screen redraw of the
   * whole scrollback — the single most expensive thing this extension can do.
   *
   * So groups are never removed: the oldest ones only release their captured
   * payloads, which is the memory `maxGroups` exists to bound. Rows keep
   * rendering exactly as before; only the `Alt+O` transcript is no longer
   * offered for them.
   */
  private prune(): void {
    while (
      this.unprunedGroups > this.options.maxGroups &&
      this.pruneCursor < this.groups.length
    ) {
      const group = this.groups[this.pruneCursor++]!;
      if (group.pruned) continue;
      this.markPruned(group);
      for (const activity of group.activities) {
        const result = activity.result;
        this.replacePayload(activity, () => {
          activity.args = {};
          if (result) {
            activity.result = {
              text: "",
              truncated: true,
              isError: result.isError,
              imageSummary: result.imageSummary,
            };
          }
        }, false);
      }
      this.touch(group);
    }
  }

  private markPruned(group: ToolGroup): void {
    if (group.pruned) return;
    group.pruned = true;
    this.unprunedGroups = Math.max(0, this.unprunedGroups - 1);
  }
}
