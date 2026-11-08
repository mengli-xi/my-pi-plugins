export interface SubagentsExecutionConfigV1 {
  readonly taskTimeoutMs: number;
  readonly maxDepth: 1 | 2;
}

export interface SubagentsCapacityConfigV1 {
  readonly activeTasksPerMain: number;
  readonly openAgentsPerMain: number;
  readonly activeTasksPerProcess: number;
}

export interface SubagentsStorageConfigV1 {
  readonly maxTasksPerAgent: number;
  readonly maxTasksPerMain: number;
  readonly maxMailboxRecordsPerConversation: number;
  readonly maxConversationBytesPerAgent: number;
  readonly maxStoreBytesPerMain: number;
  readonly maxStoreBytesPerProcess: number;
  readonly maxMetadataBytesPerMain: number;
  readonly maxMailboxBodyBytesPerConversation: number;
  readonly maxPendingDeliveryBytesPerMain: number;
}

export interface SubagentsConfigV1 {
  readonly schemaVersion: 2;
  readonly execution: SubagentsExecutionConfigV1;
  readonly capacity: SubagentsCapacityConfigV1;
  readonly storage: SubagentsStorageConfigV1;
}

export interface SubagentsConfigPatchV1 {
  readonly schemaVersion: 2;
  readonly execution?: Partial<SubagentsExecutionConfigV1>;
  readonly capacity?: Partial<SubagentsCapacityConfigV1>;
  readonly storage?: Partial<SubagentsStorageConfigV1>;
}

export type ConfigSourceKind = "user" | "project" | "merged";

export interface ConfigDiagnosticV1 {
  readonly source: ConfigSourceKind;
  readonly path: string;
  readonly message: string;
}

export type ConfigLoadResultV1 =
  | {
      readonly ok: true;
      readonly config: SubagentsConfigV1;
      readonly userConfig: SubagentsConfigV1;
      readonly sources: readonly string[];
    }
  | {
      readonly ok: false;
      readonly diagnostic: ConfigDiagnosticV1;
    };
