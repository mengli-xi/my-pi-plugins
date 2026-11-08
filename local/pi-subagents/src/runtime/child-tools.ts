import { registerSubagentMessageRenderersV1 } from "../ui/completion-renderer.js";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type ProcessWaitAdmissionRequestV2, type HostProcessWaitAdmissionV2 } from "../child/process-wait-admission.js";
import { installChildLifecycle } from "../child/lifecycle.js";
import { createChildConversationV1 } from "../child/conversation.js";
import { registerChildToolsV1 } from "../child/tools.js";
import type { ChildToolPort } from "../child/tool-port.js";
import { installEffectiveContextCapture } from "../context/capture.js";
import { MainSpawnPreparationV1 } from "../host/main-spawn-preparation.js";
import type { FrozenProfileV1 } from "../persistence/types.js";
import type { CurrentDecision, Mail, MailboxRunEnd, RecordedNotice, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import type { ChildCapabilityRegistrySnapshotV1 } from "../capabilities/registry.js";

export interface ChildIdentity { readonly mainSessionId: string; readonly agentId: `agt_${string}`; readonly generation: number; readonly sessionId: string; readonly depth: 1 | 2 }
export interface ChildHostPort {
  readonly identity: ChildIdentity;
  ready(): boolean;
  inputReady?(): void;
  viewed(details: unknown, content: string): void;
  checkMail(mail: Mail): CurrentDecision;
  mailRunEnded(end: MailboxRunEnd): void;
  recordMail(notice: RecordedNotice): Promise<void>;
  terminalMail(evidence: TerminalEvidence): Promise<void>;
  executionDisposed(): Promise<void>;
  reloadWhenQuiescent(inspect: () => string | undefined, reload: () => Promise<void>): Promise<void>;
  assertInput(items: readonly import("../child/mailbox-injection.js").MailboxDeliveryItemV1[]): void;
  taskId(): string;
  readonly tools: ChildToolPort;
  processAdmission(input: ProcessWaitAdmissionRequestV2): Promise<HostProcessWaitAdmissionV2>;
  recordProcessWait(input: { taskId: string; blocking: readonly { leaseId: string; generation: number; logicalKey: string }[] }): Promise<void>;
  settled(input: { taskId: string; aborted: boolean; sessionFile: string }): Promise<void>;
  report(error: unknown): void;
  interrupt(): Promise<void>;
  shutdown(): void;
}

export function createChildTools(input: { host: ChildHostPort; profile: FrozenProfileV1; registry: ChildCapabilityRegistrySnapshotV1; agentDir: string; skillPath: string; taskTimeoutMs: number; maxDepth?: 1 | 2 }) {
  const { host, profile } = input;
  let conversation: ReturnType<typeof createChildConversationV1> | undefined;
  let lifecycle: ReturnType<typeof installChildLifecycle> | undefined;
  const extension: ExtensionFactory = pi => {
    registerSubagentMessageRenderersV1(pi,host.viewed);
    conversation = createChildConversationV1(pi, () => ({ parentConversationSessionId: host.identity.sessionId, agentId: host.identity.agentId,
      taskId: host.taskId(), runtimeGeneration: host.identity.generation }), { agentDir: input.agentDir, assertInput: host.assertInput,
      check: host.checkMail, recorded: host.recordMail, terminal: host.terminalMail, afterRun: host.mailRunEnded });
    const preparation = new MainSpawnPreparationV1({ pi, agentDirectory: input.agentDir, skillPath: input.skillPath,
      taskTimeoutMs: input.taskTimeoutMs, maxDepth: Math.min(profile.delegation_max_depth, input.maxDepth ?? 1) as 1 | 2, frozenParent: profile, capabilitySnapshot: input.registry });
    installEffectiveContextCapture(pi, () => import("../context/effective.js"));
    registerChildToolsV1(pi, host.tools, preparation, host.identity.depth < Math.min(profile.delegation_max_depth, input.maxDepth ?? 1));
    pi.on("before_provider_request", () => host.tools.assertReady());
    pi.on("session_start", (_event, ctx) => { conversation!.bind(ctx); });
    lifecycle = installChildLifecycle(pi, {
      ready: host.ready, taskId: host.taskId,
      identity: () => ({ ...host.identity, ownerKey: host.identity.mainSessionId }),
      frozenModel: () => ({ provider: profile.provider, modelId: profile.model, reasoningEffort: profile.reasoning_effort, serviceTier: profile.service_tier }),
      processAdmission: host.processAdmission, recordProcessWait: host.recordProcessWait, settled: host.settled, report: host.report, shutdown: host.shutdown,
    });
    pi.on("session_shutdown", () => { conversation?.dispose(); });
  };
  return { extension, getBridge: (sessionId: string) => lifecycle?.getBridge(sessionId), get conversation() { if (!conversation) throw new Error("Child tools are not bound"); return conversation; } };
}
