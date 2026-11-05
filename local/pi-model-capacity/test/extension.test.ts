import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piModelCapacity from "../index.ts";
import {
  MODEL_CAPACITY_REQUEST_CHANNEL,
  type ModelCapacitySnapshotV2,
} from "../src/contracts.ts";

class Bus {
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
  on(channel: string, handler: (payload: unknown) => void): () => void {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }
  emit(channel: string, payload: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(payload);
  }
}

test("extension registers /usage, binds a session, and retires its event owner on shutdown", (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-capacity-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const bus = new Bus();
  const handlers = new Map<string, Function>();
  const commands = new Map<string, unknown>();
  const pi = {
    events: bus,
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
  };
  piModelCapacity(pi as never);
  assert.ok(commands.has("usage"));
  assert.deepEqual([...handlers.keys()].sort(), ["agent_settled", "session_shutdown", "session_start", "turn_end"]);

  const context = { sessionManager: { getSessionId: () => "session-1" } };
  handlers.get("session_start")?.({ reason: "startup" }, context);
  let snapshot: ModelCapacitySnapshotV2 | undefined;
  bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
    version: 2,
    sessionId: "session-1",
    reply: (value: ModelCapacitySnapshotV2) => { snapshot = value; },
  });
  assert.equal(snapshot?.sessionId, "session-1");
  const firstOwner = snapshot?.ownerId;

  handlers.get("session_shutdown")?.({ reason: "quit" }, context);
  snapshot = undefined;
  bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
    version: 2,
    sessionId: "session-1",
    reply: (value: ModelCapacitySnapshotV2) => { snapshot = value; },
  });
  assert.equal(snapshot, undefined);
  handlers.get("session_start")?.({ reason: "resume" }, context);
  let restored: ModelCapacitySnapshotV2 | undefined;
  bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
    version: 2, reply: (value: ModelCapacitySnapshotV2) => { restored = value; },
  });
  assert.equal(restored?.sessionId, "session-1");
  assert.notEqual(restored?.ownerId, firstOwner);
  handlers.get("session_shutdown")?.({ reason: "quit" }, context);
});
