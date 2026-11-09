import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TypewriterClock } from "./streaming-typewriter.ts";
import { ThinkingDocument } from "./thinking-document.ts";

export interface ActivityThinkingSnapshot {
  kind: "thinking";
  id: string;
  messageKey: string;
  document: ThinkingDocument;
  body: string;
  startedAt?: number;
  endedAt?: number;
  active: boolean;
  /** Full reasoning payload was released to keep the session projection bounded. */
  pruned?: boolean;
}

export interface ActivityToolsSnapshot {
  kind: "tools";
  id: string;
  messageKey: string;
  toolCallIds: readonly string[];
  createdAt: number;
}

export type ActivityTimelineItemSnapshot =
  | ActivityThinkingSnapshot
  | ActivityToolsSnapshot;

export interface ActivityPhaseSnapshot {
  id: string;
  items: readonly ActivityTimelineItemSnapshot[];
  status: "active" | "completed";
  hasTranscriptAnchor: boolean;
  createdAt: number;
  updatedAt: number;
  /** Full Thinking payloads were released; item order and tool references remain. */
  pruned?: boolean;
}

export interface ThinkingChatProjection {
  id: string;
  document: ThinkingDocument;
  startedAt?: number;
  endedAt?: number;
  active: boolean;
  visible: boolean;
}

export interface ActivityTimelineOptions {
  clock?: TypewriterClock;
  isManagedTool(toolName: string, args: unknown): boolean;
  isTranscriptAnchor?(toolName: string, args: unknown): boolean;
  maxPhases?: number;
  maxCapturedBytes?: number;
}

interface ThinkingItem {
  kind: "thinking";
  id: string;
  messageKey: string;
  document: ThinkingDocument;
  startedAt?: number;
  endedAt?: number;
  active: boolean;
  capturedBytes: number;
  pruned?: boolean;
}

interface ToolsItem {
  kind: "tools";
  id: string;
  messageKey: string;
  toolCallIds: string[];
  createdAt: number;
}

type TimelineItem = ThinkingItem | ToolsItem;

interface ActivityPhase {
  id: string;
  items: TimelineItem[];
  status: "active" | "completed";
  hasTranscriptAnchor: boolean;
  transcriptAnchorToolCallIds: Set<string>;
  createdAt: number;
  updatedAt: number;
  messageKeys: Set<string>;
  pruned?: boolean;
}

interface MessageRecord {
  key: string;
  phaseIds: Map<number, string>;
  itemIds: Map<string, string>;
  closedBoundaries: Set<number>;
}

interface ParsedThinking {
  kind: "thinking";
  key: string;
  body: string;
}

interface ParsedTools {
  kind: "tools";
  key: string;
  tools: Array<{ id: string; name: string; args: unknown }>;
}

type ParsedItem = ParsedThinking | ParsedTools;

interface ParsedSection {
  index: number;
  items: ParsedItem[];
  closesAfter: boolean;
}

const RELEASED_THINKING = "Historical Thinking details were released to keep transcript memory bounded.";

const DEFAULT_CLOCK: TypewriterClock = {
  now: Date.now,
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};

/** Preserve content order while treating visible assistant prose as a boundary. */
function parseSections(message: AssistantMessage): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let section: ParsedSection = { index: 0, items: [], closesAfter: false };
  let thinking: { key: string; parts: string[] } | undefined;
  let tools: ParsedTools | undefined;
  const flushThinking = (): void => {
    if (!thinking) return;
    section.items.push({
      kind: "thinking",
      key: thinking.key,
      body: thinking.parts.join("\n\n"),
    });
    thinking = undefined;
  };
  const flushTools = (): void => {
    if (!tools) return;
    section.items.push(tools);
    tools = undefined;
  };
  const flushItems = (): void => {
    flushThinking();
    flushTools();
  };

  for (let index = 0; index < message.content.length; index++) {
    const content = message.content[index]!;
    if (content.type === "thinking") {
      const body = content.thinking.trim();
      if (!body) continue;
      flushTools();
      thinking ??= { key: `thinking:${index}`, parts: [] };
      thinking.parts.push(body);
      continue;
    }
    if (content.type === "toolCall") {
      flushThinking();
      tools ??= { kind: "tools", key: `tools:${index}`, tools: [] };
      tools.tools.push({
        id: content.id,
        name: content.name,
        args: content.arguments,
      });
      continue;
    }
    if (content.type === "text" && content.text.trim()) {
      flushItems();
      section.closesAfter = true;
      sections.push(section);
      section = { index: section.index + 1, items: [], closesAfter: false };
    }
  }
  flushItems();
  sections.push(section);
  return sections;
}

function activeThinkingKey(
  message: AssistantMessage,
  streaming: boolean,
): string | undefined {
  if (!streaming) return undefined;
  for (let index = message.content.length - 1; index >= 0; index--) {
    const content = message.content[index]!;
    if (content.type === "thinking") {
      if (!content.thinking.trim()) continue;
      let start = index;
      while (start > 0 && message.content[start - 1]?.type === "thinking") start--;
      return `thinking:${start}`;
    }
    if (content.type === "text" && !content.text.trim()) continue;
    return undefined;
  }
  return undefined;
}

function assistantResponseKey(message: AssistantMessage): string | undefined {
  const responseId = (message as AssistantMessage & { responseId?: unknown }).responseId;
  return typeof responseId === "string" && responseId ? `response:${responseId}` : undefined;
}

function assistantProvisionalKey(message: AssistantMessage): string {
  if (Number.isFinite(message.timestamp)) {
    return `assistant:${message.timestamp}:${message.provider ?? ""}:${message.model ?? ""}:${message.api ?? ""}`;
  }
  const firstTool = message.content.find((content) => content.type === "toolCall");
  if (firstTool?.type === "toolCall") return `tool:${firstTool.id}`;
  return `assistant:${message.provider ?? ""}:${message.model ?? ""}:${message.content.length}`;
}

export function assistantActivityMessageKey(message: AssistantMessage): string {
  return assistantResponseKey(message) ?? assistantProvisionalKey(message);
}

/**
 * Runtime-owned projection of activity between non-empty visible assistant
 * prose blocks. Tool calls/results and separate assistant responses are
 * transparent to the phase boundary.
 */
export class ActivityTimelineStore {
  private readonly phases: ActivityPhase[] = [];
  private readonly phasesById = new Map<string, ActivityPhase>();
  private readonly phaseByToolCall = new Map<string, string>();
  private readonly messageRecords = new Map<string, MessageRecord>();
  private readonly responseAliases = new Map<string, string>();
  private readonly segmentById = new Map<string, ThinkingItem>();
  private readonly phaseBySegment = new Map<string, string>();
  private readonly toolsById = new Map<string, ToolsItem>();
  private readonly messageInvalidators = new Map<string, () => void>();
  private readonly phaseSubscribers = new Map<
    string,
    Set<(snapshot: ActivityPhaseSnapshot | undefined) => void>
  >();
  private readonly reusableDocuments = new Map<string, ThinkingDocument>();
  private readonly clock: TypewriterClock;
  private readonly isManagedTool: ActivityTimelineOptions["isManagedTool"];
  private readonly isTranscriptAnchor: ActivityTimelineOptions["isTranscriptAnchor"];
  private readonly maxPhases: number;
  private readonly maxCapturedBytes: number;
  private currentPhaseId: string | undefined;
  private nextPhase = 1;
  private capturedBytes = 0;
  private restoring = false;

  constructor(options: ActivityTimelineOptions) {
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.isManagedTool = options.isManagedTool;
    this.isTranscriptAnchor = options.isTranscriptAnchor ?? options.isManagedTool;
    this.maxPhases = Math.max(1, Math.floor(options.maxPhases ?? 100));
    this.maxCapturedBytes = Math.max(1, Math.floor(options.maxCapturedBytes ?? 16_000_000));
  }

  observeAssistant(
    message: AssistantMessage,
    streaming: boolean,
    now = this.clock.now(),
  ): void {
    const key = this.resolveMessageKey(message);
    const record = this.messageRecords.get(key) ?? {
      key,
      phaseIds: new Map(),
      itemIds: new Map(),
      closedBoundaries: new Set(),
    };
    this.messageRecords.set(key, record);
    const sections = parseSections(message);
    const activeKey = activeThinkingKey(message, streaming);

    const seenThinkingKeys = new Set<string>();
    for (const section of sections) {
      const parsedItems = section.items.flatMap((item): ParsedItem[] => {
        if (item.kind === "thinking") return [item];
        const managed = item.tools.filter((tool) =>
          this.isManagedTool(tool.name, tool.args)
        );
        return managed.length > 0 ? [{ ...item, tools: managed }] : [];
      });
      let phase = this.phaseForRecordSection(record, section.index);
      if (!phase && parsedItems.length > 0) {
        phase = this.ensureCurrentPhase(now);
        record.phaseIds.set(section.index, phase.id);
      }
      if (phase) {
        phase.messageKeys.add(key);
        for (const item of parsedItems) {
          if (item.kind === "thinking") {
            seenThinkingKeys.add(`${section.index}:${item.key}`);
            this.reconcileThinking(
              phase,
              record,
              section.index,
              item,
              activeKey === item.key,
              now,
            );
          } else {
            this.reconcileTools(phase, record, section.index, item, now);
          }
        }
      }

      if (section.closesAfter && !record.closedBoundaries.has(section.index)) {
        record.closedBoundaries.add(section.index);
        const boundaryPhase = phase ?? this.currentPhase();
        if (boundaryPhase) this.completePhase(boundaryPhase, now);
        this.currentPhaseId = undefined;
      }
    }

    for (const [recordKey, itemId] of record.itemIds) {
      if (!recordKey.includes(":thinking:") || seenThinkingKeys.has(recordKey)) continue;
      const item = this.segmentById.get(itemId);
      if (item?.active) this.finishThinking(item, now);
    }
    this.notifyMessage(key);
  }

  touchTool(toolCallId: string, now = this.clock.now()): void {
    const phaseId = this.phaseByToolCall.get(toolCallId);
    const phase = phaseId ? this.phasesById.get(phaseId) : undefined;
    if (!phase) return;
    phase.updatedAt = Math.max(phase.updatedAt, now);
    this.notifyPhase(phase);
  }

  finishActiveThinking(now = this.clock.now()): void {
    const phase = this.currentPhase();
    if (!phase) return;
    let changed = false;
    for (const item of phase.items) {
      if (item.kind !== "thinking" || !item.active) continue;
      this.finishThinking(item, now);
      changed = true;
    }
    if (changed) {
      phase.updatedAt = Math.max(phase.updatedAt, now);
      this.changed(phase);
    }
  }

  finishOpenPhase(now = this.clock.now()): void {
    const phase = this.currentPhase();
    if (phase) this.completePhase(phase, now);
    this.currentPhaseId = undefined;
  }

  ensureAssistant(
    message: AssistantMessage,
    streaming: boolean,
    now = this.clock.now(),
  ): void {
    if (this.messageRecords.has(this.resolveMessageKey(message))) return;
    this.observeAssistant(message, streaming, now);
  }

  registerMessage(message: AssistantMessage, invalidate: () => void): void {
    this.messageInvalidators.set(this.resolveMessageKey(message), invalidate);
  }

  retainMessages(messages: readonly AssistantMessage[]): void {
    const keys = new Set(messages.map(message => this.resolveMessageKey(message)));
    for (const key of this.messageInvalidators.keys()) if (!keys.has(key)) this.messageInvalidators.delete(key);
  }

  thinking(id: string): ThinkingChatProjection | undefined {
    const item = this.segmentById.get(id);
    if (!item) return undefined;
    return {
      id: item.id,
      document: item.document,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      active: item.active,
      visible: this.isThinkingVisible(id),
    };
  }

  isThinkingVisible(id: string): boolean {
    const item = this.segmentById.get(id);
    if (!item) return false;
    const phaseId = this.phaseBySegment.get(id);
    const phase = phaseId ? this.phasesById.get(phaseId) : undefined;
    return item.active || !phase?.hasTranscriptAnchor;
  }

  thinkingForMessage(message: AssistantMessage): ThinkingChatProjection[] | undefined {
    const record = this.messageRecords.get(this.resolveMessageKey(message));
    if (!record) return undefined;
    const result: ThinkingChatProjection[] = [];
    for (const section of [...record.phaseIds.keys()].sort((a, b) => a - b)) {
      const phaseId = record.phaseIds.get(section);
      const phase = phaseId ? this.phasesById.get(phaseId) : undefined;
      if (!phase) continue;
      for (const item of phase.items) {
        if (item.kind !== "thinking" || item.messageKey !== record.key) continue;
        const projection = this.thinking(item.id);
        if (projection) result.push(projection);
      }
    }
    return result;
  }

  phaseForToolCall(toolCallId: string): ActivityPhaseSnapshot | undefined {
    const phaseId = this.phaseByToolCall.get(toolCallId);
    return phaseId ? this.snapshot(this.phasesById.get(phaseId)) : undefined;
  }

  /**
   * Attribute archived Thinking to the grouped tool batch that follows it.
   * Trailing reasoning belongs to the phase's final grouped batch, so every
   * hidden segment remains represented without being counted on two rows.
   */
  thinkingElapsedForToolCalls(toolCallIds: readonly string[]): number | undefined {
    const targetIds = new Set(toolCallIds);
    const phaseIds = new Set(
      toolCallIds
        .map((toolCallId) => this.phaseByToolCall.get(toolCallId))
        .filter((phaseId): phaseId is string => phaseId !== undefined),
    );
    if (targetIds.size === 0 || phaseIds.size !== 1) return undefined;
    const phase = this.phasesById.get([...phaseIds][0]!);
    if (!phase?.hasTranscriptAnchor) return undefined;
    const anchorIndexes = phase.items.flatMap((item, index) =>
      item.kind === "tools" && item.toolCallIds.some((toolCallId) =>
          phase.transcriptAnchorToolCallIds.has(toolCallId)
        )
        ? [index]
        : []
    );

    let elapsed = 0;
    let measured = false;
    for (let index = 0; index < phase.items.length; index++) {
      const item = phase.items[index]!;
      if (
        item.kind !== "thinking" || item.active ||
        item.startedAt === undefined || item.endedAt === undefined
      ) continue;
      const ownerIndex = anchorIndexes.find((candidate) => candidate > index) ??
        [...anchorIndexes].reverse().find((candidate) => candidate < index);
      const owner = ownerIndex === undefined ? undefined : phase.items[ownerIndex];
      if (
        owner?.kind !== "tools" ||
        !owner.toolCallIds.some((toolCallId) => targetIds.has(toolCallId))
      ) continue;
      elapsed += Math.max(0, item.endedAt - item.startedAt);
      measured = true;
    }
    return measured ? elapsed : undefined;
  }

  subscribe(
    phaseId: string,
    listener: (snapshot: ActivityPhaseSnapshot | undefined) => void,
  ): () => void {
    const listeners = this.phaseSubscribers.get(phaseId) ?? new Set();
    listeners.add(listener);
    this.phaseSubscribers.set(phaseId, listeners);
    this.safeNotify(listener, this.snapshot(this.phasesById.get(phaseId)));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.phaseSubscribers.delete(phaseId);
    };
  }

  list(): ActivityPhaseSnapshot[] {
    return this.phases.map((phase) => this.snapshot(phase)!);
  }

  retainedPayloadBytes(): number {
    return this.capturedBytes;
  }

  retainedPhaseCount(): number {
    return this.phases.filter((phase) => !phase.pruned).length;
  }

  beginRestore(): void {
    this.reusableDocuments.clear();
    for (const item of this.segmentById.values()) {
      this.reusableDocuments.set(item.id, item.document);
    }
    this.resetState(true, true);
    this.restoring = true;
  }

  endRestore(): void {
    this.restoring = false;
    for (const document of this.reusableDocuments.values()) document.dispose();
    this.reusableDocuments.clear();
    for (const [responseKey, canonical] of this.responseAliases) {
      if (!this.messageRecords.has(canonical)) this.responseAliases.delete(responseKey);
    }
    this.invalidateAllMessages();
  }

  clear(): void {
    this.resetState(false);
  }

  private resolveMessageKey(message: AssistantMessage): string {
    const responseKey = assistantResponseKey(message);
    if (!responseKey) return assistantProvisionalKey(message);
    const alias = this.responseAliases.get(responseKey);
    if (alias) return alias;
    const provisionalKey = assistantProvisionalKey(message);
    const canonical = this.messageRecords.has(provisionalKey) ? provisionalKey : responseKey;
    this.responseAliases.set(responseKey, canonical);
    return canonical;
  }

  private phaseForRecordSection(
    record: MessageRecord,
    sectionIndex: number,
  ): ActivityPhase | undefined {
    const id = record.phaseIds.get(sectionIndex);
    return id ? this.phasesById.get(id) : undefined;
  }

  private ensureCurrentPhase(now: number): ActivityPhase {
    const current = this.currentPhase();
    if (current) return current;
    const phase: ActivityPhase = {
      id: `activity-${this.nextPhase++}`,
      items: [],
      status: "active",
      hasTranscriptAnchor: false,
      transcriptAnchorToolCallIds: new Set(),
      createdAt: now,
      updatedAt: now,
      messageKeys: new Set(),
    };
    this.phases.push(phase);
    this.phasesById.set(phase.id, phase);
    this.currentPhaseId = phase.id;
    return phase;
  }

  private currentPhase(): ActivityPhase | undefined {
    return this.currentPhaseId
      ? this.phasesById.get(this.currentPhaseId)
      : undefined;
  }

  private reconcileThinking(
    phase: ActivityPhase,
    record: MessageRecord,
    sectionIndex: number,
    parsed: ParsedThinking,
    active: boolean,
    now: number,
  ): void {
    const recordKey = `${sectionIndex}:${parsed.key}`;
    const existingId = record.itemIds.get(recordKey);
    let item = existingId ? this.segmentById.get(existingId) : undefined;
    let changed = false;
    if (!item) {
      const id = `${record.key}:${recordKey}`;
      const document = this.reusableDocuments.get(id) ??
        new ThinkingDocument(parsed.body, this.clock);
      this.reusableDocuments.delete(id);
      item = {
        kind: "thinking",
        id,
        messageKey: record.key,
        document,
        startedAt: active ? now : undefined,
        endedAt: undefined,
        active,
        capturedBytes: Buffer.byteLength(parsed.body, "utf8"),
      };
      phase.items.push(item);
      record.itemIds.set(recordKey, item.id);
      this.segmentById.set(item.id, item);
      this.phaseBySegment.set(item.id, phase.id);
      this.capturedBytes += item.capturedBytes;
      changed = true;
    } else {
      const previousBody = item.document.snapshot();
      item.document.update(parsed.body);
      if (previousBody !== parsed.body) {
        const nextBytes = Buffer.byteLength(parsed.body, "utf8");
        this.capturedBytes += nextBytes - item.capturedBytes;
        item.capturedBytes = nextBytes;
        changed = true;
      }
      if (active && !item.active) {
        item.active = true;
        item.startedAt ??= now;
        item.endedAt = undefined;
        changed = true;
      } else if (!active && item.active) {
        this.finishThinking(item, now);
        changed = true;
      }
    }
    item.document.updateTiming(item.startedAt, item.endedAt, item.active);
    if (changed) {
      phase.updatedAt = Math.max(phase.updatedAt, now);
      this.changed(phase);
    }
  }

  private reconcileTools(
    phase: ActivityPhase,
    record: MessageRecord,
    sectionIndex: number,
    parsed: ParsedTools,
    now: number,
  ): void {
    const recordKey = `${sectionIndex}:${parsed.key}`;
    const existingId = record.itemIds.get(recordKey);
    let item = existingId ? this.toolsById.get(existingId) : undefined;
    let changed = false;
    if (!item) {
      item = {
        kind: "tools",
        id: `${record.key}:${recordKey}`,
        messageKey: record.key,
        toolCallIds: [],
        createdAt: now,
      };
      phase.items.push(item);
      record.itemIds.set(recordKey, item.id);
      this.toolsById.set(item.id, item);
      changed = true;
    }
    for (const tool of parsed.tools) {
      if (!item.toolCallIds.includes(tool.id)) {
        item.toolCallIds.push(tool.id);
        changed = true;
      }
      if (this.phaseByToolCall.get(tool.id) !== phase.id) {
        this.phaseByToolCall.set(tool.id, phase.id);
        changed = true;
      }
    }
    for (const tool of parsed.tools) {
      if (
        !phase.transcriptAnchorToolCallIds.has(tool.id) &&
        this.isTranscriptAnchor?.(tool.name, tool.args)
      ) {
        phase.transcriptAnchorToolCallIds.add(tool.id);
        phase.hasTranscriptAnchor = true;
        changed = true;
      }
    }
    if (changed) {
      phase.updatedAt = Math.max(phase.updatedAt, now);
      this.changed(phase);
    }
  }

  private completePhase(phase: ActivityPhase, now: number): void {
    if (phase.status === "completed") return;
    phase.status = "completed";
    phase.updatedAt = Math.max(phase.updatedAt, now);
    for (const item of phase.items) {
      if (item.kind === "thinking" && item.active) this.finishThinking(item, now);
    }
    this.changed(phase);
    this.enforceRetention();
  }

  private finishThinking(item: ThinkingItem, now: number): void {
    item.active = false;
    if (item.startedAt !== undefined) item.endedAt ??= now;
    item.document.updateTiming(item.startedAt, item.endedAt, false);
  }

  private changed(phase: ActivityPhase): void {
    if (this.restoring) return;
    for (const key of phase.messageKeys) this.notifyMessage(key);
    this.notifyPhase(phase);
  }

  private notifyPhase(phase: ActivityPhase): void {
    const listeners = this.phaseSubscribers.get(phase.id);
    if (!listeners?.size) return;
    const snapshot = this.snapshot(phase);
    for (const listener of [...listeners]) this.safeNotify(listener, snapshot);
  }

  private notifyMessage(key: string): void {
    try {
      this.messageInvalidators.get(key)?.();
    } catch {
      // Historical or replaced message components may already be detached.
    }
  }

  private invalidateAllMessages(): void {
    for (const invalidate of this.messageInvalidators.values()) {
      try {
        invalidate();
      } catch {
        // Historical or replaced message components may already be detached.
      }
    }
  }

  private snapshot(phase: ActivityPhase | undefined): ActivityPhaseSnapshot | undefined {
    if (!phase) return undefined;
    return {
      id: phase.id,
      items: phase.items.map((item) => item.kind === "thinking"
        ? {
          kind: "thinking" as const,
          id: item.id,
          messageKey: item.messageKey,
          document: item.document,
          body: item.document.snapshot(),
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          active: item.active,
          pruned: item.pruned,
        }
        : {
          kind: "tools" as const,
          id: item.id,
          messageKey: item.messageKey,
          toolCallIds: [...item.toolCallIds],
          createdAt: item.createdAt,
        }),
      status: phase.status,
      hasTranscriptAnchor: phase.hasTranscriptAnchor,
      createdAt: phase.createdAt,
      updatedAt: phase.updatedAt,
      pruned: phase.pruned,
    };
  }

  private enforceRetention(): void {
    const retained = this.phases.filter((phase) => phase.status === "completed" && !phase.pruned);
    let overCount = Math.max(0, retained.length - this.maxPhases);
    for (const phase of retained) {
      if (overCount <= 0 && this.capturedBytes <= this.maxCapturedBytes) break;
      this.prunePhase(phase);
      if (overCount > 0) overCount--;
    }
  }

  private prunePhase(phase: ActivityPhase): void {
    if (phase.pruned || phase.status !== "completed") return;
    phase.pruned = true;
    for (const item of phase.items) {
      if (item.kind !== "thinking" || item.pruned) continue;
      this.capturedBytes = Math.max(0, this.capturedBytes - item.capturedBytes);
      item.capturedBytes = 0;
      item.pruned = true;
      item.document.update(RELEASED_THINKING);
      item.document.updateTiming(undefined, undefined, false);
      item.document.dispose();
    }
    for (const key of phase.messageKeys) {
      this.notifyMessage(key);
      const record = this.messageRecords.get(key);
      const retainedElsewhere = record && [...record.phaseIds.values()].some((phaseId) => {
        const candidate = this.phasesById.get(phaseId);
        return candidate && !candidate.pruned;
      });
      if (!retainedElsewhere) this.messageInvalidators.delete(key);
    }
    this.notifyPhase(phase);
  }

  private safeNotify(
    listener: (snapshot: ActivityPhaseSnapshot | undefined) => void,
    snapshot: ActivityPhaseSnapshot | undefined,
  ): void {
    try {
      listener(snapshot);
    } catch {
      // Activity panels are observers and cannot fail message/tool lifecycle.
    }
  }

  private resetState(preserveBindings: boolean, preserveDocuments = false): void {
    if (!preserveDocuments) {
      for (const phase of this.phases) {
        for (const item of phase.items) {
          if (item.kind === "thinking") item.document.dispose();
        }
      }
      for (const document of this.reusableDocuments.values()) document.dispose();
      this.reusableDocuments.clear();
    }
    for (const listeners of this.phaseSubscribers.values()) {
      for (const listener of listeners) this.safeNotify(listener, undefined);
    }
    this.phaseSubscribers.clear();
    this.phases.length = 0;
    this.phasesById.clear();
    this.phaseByToolCall.clear();
    this.messageRecords.clear();
    if (!preserveDocuments) this.responseAliases.clear();
    this.segmentById.clear();
    this.phaseBySegment.clear();
    this.toolsById.clear();
    this.capturedBytes = 0;
    this.currentPhaseId = undefined;
    this.nextPhase = 1;
    if (!preserveBindings) this.messageInvalidators.clear();
  }
}

export function rebuildActivityTimelineFromSession(
  entries: readonly SessionEntry[],
  timeline: ActivityTimelineStore,
): void {
  timeline.beginRestore();
  try {
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        timeline.observeAssistant(message, false, message.timestamp);
      }
    }
    timeline.finishActiveThinking();
  } finally {
    timeline.endRestore();
  }
}
