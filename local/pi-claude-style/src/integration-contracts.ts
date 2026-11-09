/** Runtime handshakes shared with independently loaded packages. */
export const PERF_REGISTRY_KEY = Symbol.for("pi.perf.ui-metrics.v3");
export const PERF_TELEMETRY_KEY = Symbol.for("pi.perf.telemetry.v1");
/** Process-wide synchronous presentation registry owned by CC Style. */
export const CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION =
  "pi.claude-style.custom-entry-presentations.v1";
export const CUSTOM_ENTRY_PRESENTATIONS_KEY = Symbol.for(
  CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION,
);
/** Editor chrome owns Image marker ↔ clipboard path mappings. */
export const EDITOR_IMAGE_SOURCE_KEY_DESCRIPTION =
  "pi.claude-style.editor-image-source.v2";
export const EDITOR_IMAGE_SOURCE_KEY = Symbol.for(
  EDITOR_IMAGE_SOURCE_KEY_DESCRIPTION,
);
export const CTX_STATUS_CUSTOM_ENTRY_TYPE = "ctx-status";
export const PROCESS_EVENT_CUSTOM_ENTRY_TYPE = "process-event-v2";
/** Owned by pi-subagents; copied contract, no package import. */
export const SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE = "subagent-completion-v1";
/** Owned by pi-skills; copied contract, no package import. */
export const SKILL_BINDING_ENTRY_TYPE = "pi-skills:binding-v1";
export const LEGACY_SKILL_BINDING_ENTRY_TYPE = "pi-skill-mentions:binding-v1";
export const AGENT_SKILL_READ_ENTRY_TYPE = "pi-skills:agent-read-v1";
export const STATUS_LINE_ROW_CHANNEL = "statusline:row";
export const STATUS_LINE_REFRESH_CHANNEL = "statusline:refresh";
export const STATUS_LINE_GOAL_ROW_KEY = "goal";
export const STATUS_LINE_TODO_SLOT_KEY = "todo";
export const STATUS_LINE_PROCESSES_ROW_KEY = "processes";
/** Owned by pi-processes; copied contract, no package import. */
export const PROCESSES_STATUS_SNAPSHOT_CHANNEL = "statusline:processes-snapshot-v2";
export const PROCESSES_SNAPSHOT_REQUEST_CHANNEL = "processes:snapshot-request-v2";
export const PROCESSES_OPEN_REQUEST_CHANNEL = "processes:open-request-v2";
/** Owned by pi-goal; copied contract, no package import. */
export const GOAL_SNAPSHOT_CHANNEL = "goal:snapshot-v1";
export const GOAL_SNAPSHOT_REQUEST_CHANNEL = "goal:request:snapshot-v1";
/** Owned by pi-todo; copied contract, no package import. */
export const TODO_SNAPSHOT_CHANNEL = "todo:snapshot-v1";
export const TODO_SNAPSHOT_REQUEST_CHANNEL = "todo:request:snapshot-v1";
/** Owned by pi-model-capacity; copied contract, no package import. */
export const MODEL_CAPACITY_SNAPSHOT_CHANNEL = "model-capacity:snapshot-v2";
export const MODEL_CAPACITY_REQUEST_CHANNEL = "model-capacity:request-snapshot-v2";
export const MODEL_CAPACITY_WATCH_CHANNEL = "model-capacity:watch-v2";
export const MODEL_CAPACITY_READY_CHANNEL = "model-capacity:adapter-ready-v1";
