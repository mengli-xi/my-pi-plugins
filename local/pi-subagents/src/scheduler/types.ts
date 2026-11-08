export type ResidentStateV1 =
  | "active"
  | "waiting-pinned"
  | "control-pinned"
  | "idle";

export interface SchedulerProcessLimitsV1 {
  readonly activeTasksPerProcess: number;
}

export interface SchedulerHostLimitsV1 {
  readonly activeTasksPerMain: number;
}

export interface HostRegistrationV1 {
  readonly version: 1;
  readonly mainSessionId: string;
  readonly hostGeneration: number;
  readonly limits: SchedulerHostLimitsV1;
}

export interface HostTokenV1 {
  readonly version: 1;
  readonly mainSessionId: string;
  readonly hostGeneration: number;
  readonly hostOrdinal: number;
  readonly bindingNonce: string;
  readonly coordinatorGeneration: number;
}

export interface TaskStartRequestV1 {
  readonly version: 1;
  readonly request_id: string;
  readonly main_session_id: string;
  readonly host_generation: number;
  readonly agent_id: string;
  readonly task_id: string;
  readonly admission_order: number;
  readonly needs_residency: boolean;
  readonly enqueued_at_ms: number;
}

export interface TaskStartGrantV1 {
  readonly version: 1;
  readonly grant_id: string;
  readonly active: true;
  readonly residency: "existing" | "granted";
  readonly main_session_id: string;
  readonly agent_id: string;
  readonly task_id: string;
  readonly coordinator_generation: number;
}

export interface ViewResidencyGrantV1 {
  readonly version: 1;
  readonly main_session_id: string;
  readonly agent_id: string;
  readonly coordinator_generation: number;
  readonly residency: "granted";
}

export type ViewResidencyRequestResultV1 =
  | { readonly state: "granted"; readonly grant: ViewResidencyGrantV1 }
  | { readonly state: "pending-capacity" }
  | { readonly state: "unavailable" };

export interface SchedulerGrantEventV1 {
  readonly version: 1;
  readonly type: "grant";
  readonly requestId: string;
  readonly hostGeneration: number;
  readonly grant: TaskStartGrantV1;
}

export type SchedulerHostEventV1 = SchedulerGrantEventV1;

export interface ReleaseGrantInputV1 {
  readonly grantId: string;
  readonly coordinatorGeneration: number;
  readonly runtimeGeneration?: number;
  readonly nextResidency: "idle" | "waiting-pinned" | "control-pinned" | "release-residency";
  readonly atMonotonicMs: number;
}

export interface ResidentTransitionInputV1 {
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly state: "idle" | "waiting-pinned" | "control-pinned";
  readonly pinnedTaskId?: string;
  readonly atMonotonicMs: number;
}

export interface SchedulerResidentSnapshotV1 {
  readonly mainSessionId: string;
  readonly hostGeneration: number;
  readonly hostOrdinal: number;
  readonly agentId: string;
  readonly runtimeGeneration?: number;
  readonly pinnedTaskId?: string;
  readonly state: ResidentStateV1;
  readonly lastUsedMonotonicMs: number;
}

export interface SchedulerGrantSnapshotV1 {
  readonly grantId: string;
  readonly mainSessionId: string;
  readonly hostGeneration: number;
  readonly agentId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly coordinatorGeneration: number;
  readonly residency: "existing" | "granted";
}

export interface SchedulerHostSnapshotV1 {
  readonly mainSessionId: string;
  readonly hostGeneration: number;
  readonly hostOrdinal: number;
  readonly limits: SchedulerHostLimitsV1;
  readonly queuedRequestIds: readonly string[];
  readonly activeCount: number;
  readonly residentCount: number;
  readonly idleCount: number;
  readonly eventCount: number;
}

export interface SchedulerSnapshotV1 {
  readonly version: 1;
  readonly coordinatorGeneration: number;
  readonly limits: SchedulerProcessLimitsV1;
  readonly activeCount: number;
  readonly residentCount: number;
  readonly queuedCount: number;
  readonly hosts: readonly SchedulerHostSnapshotV1[];
  readonly grants: readonly SchedulerGrantSnapshotV1[];
  readonly residents: readonly SchedulerResidentSnapshotV1[];
}

export interface SchedulerHealthV1 {
  readonly version: 1;
  readonly status: "healthy" | "degraded";
  readonly capacityReason?: "runtime-capacity";
  readonly failedEvictions: readonly {
    readonly mainSessionId: string;
    readonly agentId: string;
    readonly runtimeGeneration: number;
  }[];
}

export interface SchedulerIdSourceV1 {
  next(kind: "binding" | "grant"): string;
}
