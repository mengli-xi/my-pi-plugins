import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProcessHost } from "../../src/host/process-host.ts";
import { installProcessesStatusProtocol, PROCESSES_MANAGED_SNAPSHOT_CHANNEL, PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, type ProcessesManagedSnapshotV1 } from "../../src/integrations/status-protocol.ts";

class EventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();
  on(channel: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => { handlers.delete(handler); };
  }
  emit(channel: string, value: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }
}

for (const consumerFirst of [true, false]) {
  test(`managed snapshot synchronizes with ${consumerFirst ? "consumer" : "owner"} loaded first and rejects detached scopes`, async () => {
    const bus = new EventBus();
    const owner = new ProcessHost({ sessionScopeId: "scope-a", launch: async () => { throw new Error("snapshot must not launch a helper"); } });
    let runtime = { sessionScopeId: "scope-a", host: owner, managed: true, hasUI: false, open() {}, report() {} };
    const seen: ProcessesManagedSnapshotV1[] = [];
    const subscribe = () => bus.on(PROCESSES_MANAGED_SNAPSHOT_CHANNEL, value => { seen.push(value as ProcessesManagedSnapshotV1); });
    let unsubscribe: (() => void) | undefined;
    if (consumerFirst) unsubscribe = subscribe();
    const protocol = installProcessesStatusProtocol({ events: bus } as unknown as Pick<ExtensionAPI, "events">, () => runtime);
    protocol.attach(runtime);
    if (!consumerFirst) unsubscribe = subscribe();
    bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { version: 1, scope_id: "scope-a", requestId: "request-a" });
    assert.ok(seen.length > 0);
    assert.equal(seen.at(-1)!.scope_id, "scope-a");
    assert.deepEqual(JSON.parse(JSON.stringify(seen.at(-1))), seen.at(-1), "snapshot is cross-process serializable");
    const firstGeneration = seen.at(-1)!.host_generation;
    protocol.detach();
    const detachedCount = seen.length;
    bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { version: 1, scope_id: "scope-a", requestId: "request-detached" });
    await owner.dispose("scope-ended");
    assert.equal(seen.length, detachedCount, "late owner cleanup cannot publish after detach");
    const replacement = new ProcessHost({ sessionScopeId: "scope-b", launch: async () => { throw new Error("snapshot must not launch a helper"); } });
    runtime = { ...runtime, sessionScopeId: "scope-b", host: replacement };
    protocol.attach(runtime);
    assert.notEqual(seen.at(-1)!.host_generation, firstGeneration);
    const replacementCount = seen.length;
    bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { version: 1, scope_id: "scope-a", requestId: "late-old-scope" });
    assert.equal(seen.length, replacementCount);
    protocol.detach();
    unsubscribe?.();
    await replacement.dispose("scope-ended");
  });
}
