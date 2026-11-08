import { TASK_TIMEOUT_DEFAULT_MS, TASK_TIMEOUT_MIN_MS, TASK_TIMEOUT_MAX_MS } from "../domain/task-policy.js";
import type {
  SubagentsConfigPatchV1,
  SubagentsConfigV1,
} from "./types.js";

const MAINTENANCE_ALLOWANCE_BYTES = 16_777_216;

const ROOT_KEYS = ["schemaVersion", "execution", "capacity", "storage"] as const;
const EXECUTION_KEYS = ["taskTimeoutMs", "maxDepth"] as const;
const CAPACITY_KEYS = [
  "activeTasksPerMain",
  "openAgentsPerMain",
  "activeTasksPerProcess",
] as const;
const STORAGE_KEYS = [
  "maxTasksPerAgent",
  "maxTasksPerMain",
  "maxMailboxRecordsPerConversation",
  "maxConversationBytesPerAgent",
  "maxStoreBytesPerMain",
  "maxStoreBytesPerProcess",
  "maxMetadataBytesPerMain",
  "maxMailboxBodyBytesPerConversation",
  "maxPendingDeliveryBytesPerMain",
] as const;

export const PROJECT_FORBIDDEN_PROCESS_KEYS = Object.freeze([
  "capacity.activeTasksPerProcess",
  "storage.maxStoreBytesPerProcess",
] as const);

export function defaultSubagentsConfig(): SubagentsConfigV1 {
  return {
    schemaVersion: 2,
    execution: {
      taskTimeoutMs: TASK_TIMEOUT_DEFAULT_MS,
      maxDepth: 1,
    },
    capacity: {
      activeTasksPerMain: 10,
      activeTasksPerProcess: 10,
      openAgentsPerMain: 32,
    },
    storage: {
      maxTasksPerAgent: 256,
      maxTasksPerMain: 4_096,
      maxMailboxRecordsPerConversation: 1_024,
      maxConversationBytesPerAgent: 67_108_864,
      maxStoreBytesPerMain: 536_870_912,
      maxStoreBytesPerProcess: 2_147_483_648,
      maxMetadataBytesPerMain: 67_108_864,
      maxMailboxBodyBytesPerConversation: 4_194_304,
      maxPendingDeliveryBytesPerMain: 16_777_216,
    },
  };
}

function fail(path: string, message: string): never {
  const localized = message.startsWith("must be") ? `${message.replace("must be", "必须满足")}；请修正此值或相关配置上限。` : message;
  throw new Error(`${path}: ${localized}`);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(path, "必须是 JSON 对象；请修正此值。");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${path}.${key}`, "未知配置键；请移除此键或改为文档中的完整键名。");
  }
}

function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  path: string,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < min ||
    candidate > max
  ) {
    return fail(path, `必须为 ${min}..${max} 范围的整数；请修正此值。`);
  }
  return candidate;
}

function section(
  root: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> {
  const candidate = root[key];
  if (candidate === undefined) return {};
  const result = plainObject(candidate, path);
  exactKeys(result, allowed, path);
  return result;
}

export function validateConfigPatch(
  value: unknown,
  path = "$config",
): SubagentsConfigPatchV1 {
  const root = plainObject(value, path);
  const removed: string[] = [];
  const deleted = {
    execution: ["helperRuntime", "runtimeStopGraceMs"],
    capacity: ["residentChildrenPerMain", "idleResidentsPerMain", "residentChildrenPerProcess"],
    storage: ["maxAgentsPerMain"],
  };
  for (const [section, keys] of Object.entries(deleted)) {
    const value = root[section];
    if (value && typeof value === "object") for (const key of keys) if (Object.hasOwn(value, key)) {
      removed.push(`${path}: ${section}.${key} 已删除；请移除此键，${key === "maxAgentsPerMain" ? "改用 capacity.openAgentsPerMain，closed Agent 不计数" : "使用 close_agent 管理生命周期"}。`);
    }
  }
  if (Object.hasOwn(root, "liveView")) {
    const keys = root.liveView && typeof root.liveView === "object" ? Object.keys(root.liveView) : [];
    for (const key of keys.length ? keys.map(key => `liveView.${key}`) : ["liveView"]) removed.push(`${path}: ${key} 已删除；请移除此键，SDK 界面使用原生 CC/Pinned 配置。`);
  }
  if (root.schemaVersion !== 2) removed.push(`${path}: schemaVersion 必须为 2；请更新版本，删除 resident、idle、liveView 旧配置，使用 capacity.openAgentsPerMain（closed 不计数）与 close_agent 管理生命周期。`);
  if (removed.length) throw new Error(removed.join("\n"));
  exactKeys(root, ROOT_KEYS, path);
  const execution = section(root, "execution", EXECUTION_KEYS, `${path}.execution`);
  const capacity = section(root, "capacity", CAPACITY_KEYS, `${path}.capacity`);
  const storage = section(root, "storage", STORAGE_KEYS, `${path}.storage`);
  return {
    schemaVersion: 2,
    ...(root.execution !== undefined ? { execution: execution as SubagentsConfigPatchV1["execution"] } : {}),
    ...(root.capacity !== undefined ? { capacity: capacity as SubagentsConfigPatchV1["capacity"] } : {}),
    ...(root.storage !== undefined ? { storage: storage as SubagentsConfigPatchV1["storage"] } : {}),
  };
}

export function assertProjectPatchAuthority(
  patch: SubagentsConfigPatchV1,
  path = "$project",
): void {
  if (patch.capacity?.activeTasksPerProcess !== undefined) {
    fail(`${path}.capacity.activeTasksPerProcess`, "仅允许在 user 配置设置；请从 project 配置移除此键。");
  }
  if (patch.storage?.maxStoreBytesPerProcess !== undefined) {
    fail(`${path}.storage.maxStoreBytesPerProcess`, "仅允许在 user 配置设置；请从 project 配置移除此键。");
  }
}

/**
 * CONFIG.md §1：project 文件只能收紧 per-Main/per-Agent/task/UI-local 值。放宽的数值一律
 * 退回 user 值，所有保留键都按当前限制收紧。
 */
export function clampProjectPatchV1(
  user: SubagentsConfigV1,
  patch: SubagentsConfigPatchV1,
): SubagentsConfigPatchV1 {
  const sections = ["execution", "capacity", "storage"] as const;
  const result: Record<string, unknown> = { schemaVersion: 2 };
  for (const section of sections) {
    const values = patch[section] as Record<string, unknown> | undefined;
    if (values === undefined) continue;
    const base = user[section] as unknown as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const current = base[key];
      next[key] = typeof value === "number" && typeof current === "number" ? Math.min(value, current) : value;
    }
    result[section] = next;
  }
  return result as unknown as SubagentsConfigPatchV1;
}

export function mergeConfigPatches(
  ...values: readonly (SubagentsConfigV1 | SubagentsConfigPatchV1)[]
): SubagentsConfigPatchV1 {
  const merged: {
    schemaVersion: 2;
    execution: Record<string, unknown>;
    capacity: Record<string, unknown>;
    storage: Record<string, unknown>;
  } = {
    schemaVersion: 2,
    execution: {},
    capacity: {},
    storage: {},
  };
  for (const value of values) {
    Object.assign(merged.execution, value.execution ?? {});
    Object.assign(merged.capacity, value.capacity ?? {});
    Object.assign(merged.storage, value.storage ?? {});
  }
  return merged as unknown as SubagentsConfigPatchV1;
}

export function validateSubagentsConfig(value: unknown): SubagentsConfigV1 {
  const patch = validateConfigPatch(value);
  const defaults = defaultSubagentsConfig();
  const execution = patch.execution ?? {};
  const capacity = patch.capacity ?? {};
  const storage = patch.storage ?? {};

  const activeTasksPerMain = integer(capacity.activeTasksPerMain, defaults.capacity.activeTasksPerMain, 1, 32, "$config.capacity.activeTasksPerMain");
  const activeTasksPerProcess = integer(capacity.activeTasksPerProcess, defaults.capacity.activeTasksPerProcess, 1, 64, "$config.capacity.activeTasksPerProcess");
  const openAgentsPerMain = integer(capacity.openAgentsPerMain, defaults.capacity.openAgentsPerMain, 1, 32, "$config.capacity.openAgentsPerMain");
  if (activeTasksPerMain > activeTasksPerProcess) fail("$config.capacity.activeTasksPerMain", "不得大于 capacity.activeTasksPerProcess；请降低此值或在 user 配置提高进程上限。");
  if (activeTasksPerMain > openAgentsPerMain) fail("$config.capacity.activeTasksPerMain", "不得大于 capacity.openAgentsPerMain；请降低此值或提高打开名额。");

  const maxTasksPerAgent = integer(
    storage.maxTasksPerAgent,
    defaults.storage.maxTasksPerAgent,
    1,
    256,
    "$config.storage.maxTasksPerAgent",
  );
  const maxTasksPerMain = integer(
    storage.maxTasksPerMain,
    defaults.storage.maxTasksPerMain,
    32,
    4_096,
    "$config.storage.maxTasksPerMain",
  );
  if (maxTasksPerMain < maxTasksPerAgent) {
    fail("$config.storage.maxTasksPerMain", "不得小于 storage.maxTasksPerAgent；请提高此值或降低每 Agent 的 Task 上限。");
  }
  const maxConversationBytesPerAgent = integer(
    storage.maxConversationBytesPerAgent,
    defaults.storage.maxConversationBytesPerAgent,
    1_048_576,
    67_108_864,
    "$config.storage.maxConversationBytesPerAgent",
  );
  const maxStoreBytesPerMain = integer(
    storage.maxStoreBytesPerMain,
    defaults.storage.maxStoreBytesPerMain,
    67_108_864,
    536_870_912,
    "$config.storage.maxStoreBytesPerMain",
  );
  if (maxStoreBytesPerMain < maxConversationBytesPerAgent + MAINTENANCE_ALLOWANCE_BYTES) {
    fail(
      "$config.storage.maxStoreBytesPerMain",
      `不得小于 storage.maxConversationBytesPerAgent + ${MAINTENANCE_ALLOWANCE_BYTES}；请提高此值或降低 conversation 上限。`,
    );
  }
  const maxStoreBytesPerProcess = integer(
    storage.maxStoreBytesPerProcess,
    defaults.storage.maxStoreBytesPerProcess,
    268_435_456,
    2_147_483_648,
    "$config.storage.maxStoreBytesPerProcess",
  );
  if (maxStoreBytesPerProcess < maxStoreBytesPerMain) {
    fail("$config.storage.maxStoreBytesPerProcess", "不得小于 storage.maxStoreBytesPerMain；请在 user 配置提高进程上限。");
  }
  const maxMetadataBytesPerMain = integer(
    storage.maxMetadataBytesPerMain,
    defaults.storage.maxMetadataBytesPerMain,
    8_388_608,
    67_108_864,
    "$config.storage.maxMetadataBytesPerMain",
  );
  if (maxMetadataBytesPerMain > maxStoreBytesPerMain) {
    fail("$config.storage.maxMetadataBytesPerMain", "不得大于 storage.maxStoreBytesPerMain；请降低此值或提高 Main 存储上限。");
  }

  return {
    schemaVersion: 2,
    execution: {
      maxDepth: integer(execution.maxDepth, defaults.execution.maxDepth, 1, 2, "$config.execution.maxDepth") as 1 | 2,
      taskTimeoutMs: integer(
        execution.taskTimeoutMs,
        defaults.execution.taskTimeoutMs,
        TASK_TIMEOUT_MIN_MS,
        TASK_TIMEOUT_MAX_MS,
        "$config.execution.taskTimeoutMs",
      ),
    },
    capacity: {
      activeTasksPerMain,
      openAgentsPerMain,
      activeTasksPerProcess,
    },
    storage: {
      maxTasksPerAgent,
      maxTasksPerMain,
      maxMailboxRecordsPerConversation: integer(
        storage.maxMailboxRecordsPerConversation,
        defaults.storage.maxMailboxRecordsPerConversation,
        16,
        1_024,
        "$config.storage.maxMailboxRecordsPerConversation",
      ),
      maxConversationBytesPerAgent,
      maxStoreBytesPerMain,
      maxStoreBytesPerProcess,
      maxMetadataBytesPerMain,
      maxMailboxBodyBytesPerConversation: integer(
        storage.maxMailboxBodyBytesPerConversation,
        defaults.storage.maxMailboxBodyBytesPerConversation,
        65_536,
        4_194_304,
        "$config.storage.maxMailboxBodyBytesPerConversation",
      ),
      maxPendingDeliveryBytesPerMain: integer(
        storage.maxPendingDeliveryBytesPerMain,
        defaults.storage.maxPendingDeliveryBytesPerMain,
        1_048_576,
        16_777_216,
        "$config.storage.maxPendingDeliveryBytesPerMain",
      ),
    },
  };
}
