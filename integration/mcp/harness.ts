import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, initTheme, type ExtensionAPI, type ExtensionContext, type ExtensionFactory, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMcpMailbox } from "../../fork/pi-mcp-adapter/dist/mailbox.js";
import { createMcpRuntimeOwner } from "../../fork/pi-mcp-adapter/dist/runtime-owner.js";
import { ConsentManager } from "../../fork/pi-mcp-adapter/dist/consent-manager.js";
import { BackgroundTaskRegistry } from "../../fork/pi-mcp-adapter/dist/task-jobs.js";
import { MCP_TASK_CUSTOM_TYPE, pendingTaskEntry, frozenTaskResultEntry, acceptedTaskResultEntry, taskCheckpointEntry } from "../../fork/pi-mcp-adapter/dist/task-entries.js";

export const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=";
export function text(message: { content?: unknown }): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export async function until(check: () => boolean, label = "condition") {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, 10));
  }
}

/** Real SDK/provider transport fixture. HOME is supplied by the root offline runner. */
export function mcpFixture() {
  const root = mkdtempSync(join(tmpdir(), "mcp-integration-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const keys = ["PI_CODING_AGENT_DIR", "MCP_UI_VIEWER"] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.MCP_UI_VIEWER = "none";
  initTheme("dark", false);
  const requests: Message[][] = [], errors: string[] = [];
  let respond: (messages: Message[]) => unknown | Promise<unknown> = () => fauxAssistantMessage("MCP_FAUX_OK");
  const provider: ExtensionFactory = pi => {
    const faux = fauxProvider({ provider: "mcp-joint-faux", api: "mcp-joint-faux", tokensPerSecond: 10000000,
      models: [{ id: "offline", contextWindow: 128000, maxTokens: 4096 }] });
    faux.setResponses(Array.from({ length: 40 }, () => async context => {
      requests.push(structuredClone(context.messages));
      return await respond(context.messages) as ReturnType<typeof fauxAssistantMessage>;
    }));
    pi.registerProvider(faux.provider);
  };
  const start = async (extensions: ExtensionFactory[], manager = SessionManager.create(root, join(root, "sessions")), uiContext?: ExtensionUIContext) =>
    createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd: root, agentDir,
        settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
          disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], systemPrompt: "Offline MCP mailbox integration.", extensionFactories: [...extensions, provider] },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: services.modelRuntime.getModel("mcp-joint-faux", "offline"), thinkingLevel: "off" });
      await result.session.bindExtensions({ mode: uiContext ? "tui" : "rpc", ...(uiContext ? { uiContext } : {}), shutdownHandler: () => {}, onError: event => errors.push(String(event.error)) });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd: root, agentDir, sessionManager: manager });
  return { root, agentDir, requests, errors, start,
    respond(callback: typeof respond) { respond = callback; },
    cleanup() {
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A component producer uses the real adapter guard/capture and real Inject writer.
 * Only remote Task execution and the UI/credential source state are test actors.
 * This is not the full createMcpAdapter factory; factory coverage lives separately. */
export function componentProducer() {
  let ctx: ExtensionContext;
  let mailbox: ReturnType<typeof createMcpMailbox>;
  let registry: BackgroundTaskRegistry;
  let accepted = 0;
  const owner = createMcpRuntimeOwner();
  const consentManager = new ConsentManager("never");
  const state = { owner, config: { mcpServers: { demo: { url: "http://127.0.0.1/fixture" } } }, consentManager,
    blockedProjectServers: new Map(), authStorageOptions: { credentialStore: "encrypted-file" } };
  const factory: ExtensionFactory = (pi: ExtensionAPI) => {
    mailbox = createMcpMailbox(pi, () => state as any);
    pi.on("session_start", (_event, current) => {
      ctx = current;
      const sessionId = current.sessionManager.getSessionId();
      registry = new BackgroundTaskRegistry({ decrementInFlight() {}, touch() {} } as any,
        origin => {
          if (origin && origin.scope !== "branch" && current.sessionManager.getLeafId() !== origin.anchorEntryId) {
            throw new Error("MCP task is held for its exact original leaf");
          }
          return { deliveryId: origin?.deliveryId ?? `task:${sessionId}:${randomUUID()}`, anchorEntryId: origin ? origin.anchorEntryId : current.sessionManager.getLeafId(),
            send: mailbox.capture(current, () => owner.isActive(), origin ? { anchorEntryId: origin.anchorEntryId, recovered: true } : undefined) };
        },
        owner.signal, () => {}, task => pi.appendEntry(MCP_TASK_CUSTOM_TYPE, pendingTaskEntry(sessionId, task)),
        result => pi.appendEntry(MCP_TASK_CUSTOM_TYPE, frozenTaskResultEntry(sessionId, result)),
        result => { pi.appendEntry(MCP_TASK_CUSTOM_TYPE, acceptedTaskResultEntry(sessionId, result)); accepted++; },
        checkpoint => {
          const data = taskCheckpointEntry(sessionId, checkpoint);
          const leaf = current.sessionManager.getLeafEntry();
          if (leaf?.type === "custom" && leaf.customType === MCP_TASK_CUSTOM_TYPE && JSON.stringify(leaf.data) === JSON.stringify(data)) return;
          pi.appendEntry(MCP_TASK_CUSTOM_TYPE, data);
        });
    });
    pi.on("session_shutdown", async () => { await registry.handOffForShutdown(); mailbox.close(); await owner.stop(); });
  };
  return { factory, state, consentManager, owner,
    get ctx() { return ctx; }, get registry() { return registry; }, get accepted() { return accepted; },
    sender(options?: { anchorEntryId?: string | null; recovered?: true }) { return mailbox.capture(ctx, () => owner.isActive(), options); },
    message(kind = "prompt", body = "MCP_APP_BODY") {
      return { customType: kind === "oauth" ? "mcp-oauth-status" : `mcp-ui-${kind}`, display: true,
        content: [{ type: "text" as const, text: body }, ...(kind === "prompt" ? [{ type: "image" as const, data: IMAGE, mimeType: "image/png" }] : [])],
        details: { server: "demo", ...(kind === "oauth" ? { status: "failed", error: "fixture OAuth outcome" } : { tool: "app", prompt: body }) } };
    },
  };
}

export async function collaborators() {
  const [{ default: cc }, { default: goal }] = await Promise.all([
    import(new URL("../../local/pi-claude-style/dist/index.ts", import.meta.url).href),
    import(new URL("../../fork/pi-goal/dist/index.js", import.meta.url).href),
  ]) as Array<{ default: ExtensionFactory }>;
  return [cc, goal];
}
export function assertMailboxAccepted(agentDir: string, manager: SessionManager, deliveryId: string) {
  const snapshot = join(agentDir, "mailbox", "v1", manager.getSessionId(), "pending.json");
  if (existsSync(snapshot)) {
    const value = JSON.parse(readFileSync(snapshot, "utf8"));
    if ([...value.pending, ...value.terminal].some((record: { key: string }) => record.key === deliveryId)) return;
  }
  const file = manager.getSessionFile();
  const entries = file && existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  assert.ok(entries.some((entry: { type?: string; customType?: string; data?: { terminals?: Array<{ evidence?: { key?: string } }> } }) => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1"
    && entry.data?.terminals?.some(terminal => terminal.evidence?.key === deliveryId)), "put acceptance must have a real disk snapshot or fulfilled receipt before source ACK");
}

export function assertDurableFile(manager: SessionManager, deliveryId: string) {
  assert.ok(manager.getSessionFile());
  assert.ok(readFileSync(manager.getSessionFile()!, "utf8").includes(deliveryId), "native/source ID is on the real session file, not only an in-memory queue");
}
