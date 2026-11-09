import assert from "node:assert/strict";
import { test } from "node:test";

import { getOrCreateProcessHost, getProcessHost } from "../../src/host/registry.ts";
import type { HostTransport } from "../../src/host/process-host.ts";

class PendingCleanupTransport implements HostTransport {
  supervisorPid = 42;
  closed = false;
  resolveCleanup!: (value: Record<string, unknown>) => void;
  readonly cleanupPromise = new Promise<Record<string, unknown>>((resolve) => {
    this.resolveCleanup = resolve;
  });

  async request(): Promise<Record<string, unknown>> { return {}; }
  async cleanup(): Promise<Record<string, unknown>> { return await this.cleanupPromise; }
  async waitForExit(): Promise<void> {}
  terminate(): void {}
  close(): void { this.closed = true; }
}

class IncompleteCleanupTransport extends PendingCleanupTransport {
  override async waitForExit(): Promise<void> { throw new Error("supervisor still running"); }
}

test("registry keeps one authority while cleanup is pending and releases it after success", async () => {
  const sessionScopeId = `registry-pending-${crypto.randomUUID()}`;
  const transport = new PendingCleanupTransport();
  const first = getOrCreateProcessHost({ sessionScopeId, launch: async () => transport });
  await first.ensureStarted();

  const cleanup = first.endScope();
  const during = getOrCreateProcessHost({ sessionScopeId, launch: async () => new PendingCleanupTransport() });
  assert.equal(during, first);
  assert.throws(() => during.bind({ deliver() {} }), /process host is disposed/);

  transport.resolveCleanup({ unresolved: 0 });
  await cleanup;
  assert.equal(getProcessHost(sessionScopeId), undefined);

  const replacement = getOrCreateProcessHost({ sessionScopeId, launch: async () => new PendingCleanupTransport() });
  assert.notEqual(replacement, first);
  await replacement.endScope();
});

test("registry keeps quarantined authority when cleanup cannot converge", async () => {
  const sessionScopeId = `registry-incomplete-${crypto.randomUUID()}`;
  const transport = new IncompleteCleanupTransport();
  const first = getOrCreateProcessHost({ sessionScopeId, launch: async () => transport });
  await first.ensureStarted();

  const cleanup = first.endScope();
  transport.resolveCleanup({ unresolved: 1 });
  await assert.rejects(cleanup, /cleanup-incomplete/);

  assert.equal(getProcessHost(sessionScopeId), first);
  assert.match(first.cleanupError?.message ?? "", /cleanup-incomplete/);
  const replacement = getOrCreateProcessHost({ sessionScopeId, launch: async () => new PendingCleanupTransport() });
  assert.equal(replacement, first);
  assert.throws(() => replacement.bind({ deliver() {} }), /cleanup-incomplete/);
});
