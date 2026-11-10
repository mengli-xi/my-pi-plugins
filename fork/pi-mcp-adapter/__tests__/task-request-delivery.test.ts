import { describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";

const spec = { serverName: "demo", originalName: "build", prefixedName: "demo_build", description: "Build" };
const surfaces = {
  proxy: (state: any) => executeCall(state, "demo_build", {}),
  direct: (state: any) => createDirectToolExecutor(() => state, () => null, spec)("toolu_1", {}, undefined, undefined, {} as any),
};

describe("Task request delivery target", () => {
  for (const [name, run] of Object.entries(surfaces)) {
    it(`${name} captures the source branch before the remote request, not when its Task handle arrives`, async () => {
      const original = { deliveryId: "task:original", anchorEntryId: "original-leaf", send: vi.fn() };
      let current = original;
      let answer!: (execution: unknown) => void;
      const response = new Promise(resolve => { answer = resolve; });
      const backgroundTasks = { capture: vi.fn(() => current), start: vi.fn(async () => {}) };
      const callTool = vi.fn(() => {
        expect(backgroundTasks.capture).toHaveBeenCalledTimes(1);
        return response;
      });
      const connection = { status: "connected", client: {}, taskSession: { callTool }, tools: [], resources: [] };
      const manager = {
        getConnection: vi.fn(() => connection), getRequestOptions: vi.fn(),
        touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn(),
      };
      const state = {
        config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "never-run" } } },
        manager, backgroundTasks, calledByModel: () => true, proxyToolAvailable: () => true,
        toolMetadata: new Map([["demo", [{ name: "demo_build", originalName: "build", description: "Build" }]]]),
        serverInstructions: new Map(), failureTracker: new Map(),
      };
      const pending = run(state);
      await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
      expect(backgroundTasks.start).not.toHaveBeenCalled();
      current = { deliveryId: "task:other", anchorEntryId: "other-leaf", send: vi.fn() };
      answer({ kind: "task", handle: { taskId: "t-1", operation: "tools/call" }, cancel: vi.fn(), close: vi.fn(), settle: vi.fn() });
      expect((await pending).details).toMatchObject({ task: { id: "t-1", status: "working" } });
      expect(backgroundTasks.capture).toHaveBeenCalledTimes(1);
      expect(backgroundTasks.start).toHaveBeenCalledTimes(1);
      expect(backgroundTasks.start.mock.calls[0]![0].delivery).toBe(original);
      expect(manager.decrementInFlight).not.toHaveBeenCalled();
    });
  }
});
