import { describe, expect, it } from "vitest";
import { maybeStartUiSession } from "./ui-session.ts";
import { captureMcpSender } from "./mailbox.ts";
import { createMcpRuntimeOwner } from "./runtime-owner.ts";
import { ConsentManager } from "./consent-manager.ts";
import { buildHostHtmlTemplate } from "./host-html-template.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const until = async (condition: () => boolean) => {
  const end = Date.now() + 3000;
  while (!condition()) { if (Date.now() > end) throw new Error("fixture timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
};

// Execute the actual trusted host module with a small DOM and AppBridge stand-in.
async function host(fetcher: typeof fetch, sandboxProxyUrl: string, token: string) {
  let bridge: any;
  const replies: any[] = [], listeners: any[] = [];
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", hidden: true, style: {}, events: {} as any,
      classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener(name: string, fn: any) { this.events[name] = fn; } });
    return nodes.get(id);
  };
  const frame = node("mcp-app");
  frame.contentWindow = { postMessage: (value: unknown) => replies.push(value) };
  Object.defineProperty(frame, "src", { set() { queueMicrotask(() => frame.onload()); } });
  const window = { addEventListener: (_name: string, fn: any) => listeners.push(fn), confirm: () => true, close() {} };
  const html = buildHostHtmlTemplate({ sessionToken: token, serverName: "test", toolName: "fixture", toolArgs: {}, resource: { html: "", meta: {} } as any,
    allowAttribute: "", requireToolConsent: false, cacheToolConsent: false, sandboxProxyUrl });
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!.replace(/\s*import \{ AppBridge, PostMessageTransport \} from [^;]+;/, "");
  const run = Object.getPrototypeOf(async function () {}).constructor;
  await new run("AppBridge", "PostMessageTransport", "window", "document", "crypto", "fetch", "EventSource", "setInterval", "setTimeout", script)(
    class { constructor() { bridge = this; } async connect() {} }, class {}, window,
    { getElementById: node, addEventListener() {} }, { randomUUID: () => sessionId }, fetcher,
    class { addEventListener() {} close() {} }, () => 1, () => 1);
  return { bridge, replies, nodes, raw: (data: unknown) => listeners[0]({ source: frame.contentWindow, origin: new URL(sandboxProxyUrl).origin, data }) };
}

async function serverFixture() {
  const previousViewer = process.env.MCP_UI_VIEWER;
  process.env.MCP_UI_VIEWER = "none";
  const owner = createMcpRuntimeOwner();
  const accepted: any[] = [];
  let reject = false;
  const endpoint = { target: () => ({ slotKey: '["/fixture","original"]', session: { id: "original", file: null }, bindingGeneration: 1 }),
    put: async (mail: any) => { if (reject) throw new Error("disk full"); accepted.push(mail); return { kind: "accepted", key: mail.key, revision: accepted.length }; } };
  const state = { owner, config: { mcpServers: { test: {} } }, uiServer: null, completedUiSessions: [],
    manager: { removeResourceUpdatedListener() {}, getConnection: () => undefined },
    uiResourceHandler: { readUiResource: async () => ({ html: "<html></html>", meta: {} }) }, consentManager: new ConsentManager("never"),
    captureMail: () => captureMcpSender(endpoint as any, { sessionManager: { getLeafId: () => "anchor" } } as any, () => owner.isActive()), ui: { notify() {} } };
  const ui = await maybeStartUiSession(state as any, { serverName: "test", toolName: "fixture", toolArgs: {}, uiResourceUri: "ui://fixture" });
  if (!ui) throw new Error("UI did not start");
  const url = new URL(ui.url), token = url.searchParams.get("session")!;
  const requests: { path: string; params: any }[] = [];
  const post = async (path: string, params: unknown) => fetch(new URL(path, url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, params }) });
  return { accepted, post, token, url, requests, set reject(value: boolean) { reject = value; },
    fetcher: (async (input: any, init: any) => { requests.push({ path: input, params: JSON.parse(init.body).params }); return fetch(new URL(input, url), init); }) as typeof fetch,
    async close() { ui.close("test-finished"); await owner.stop(); if (previousViewer === undefined) delete process.env.MCP_UI_VIEWER; else process.env.MCP_UI_VIEWER = previousViewer; } };
}

describe("trusted UI action acceptance", () => {
  it("retries a lost accepted reply with identical ID/payload and preserves message/context/user-action order", async () => {
    const server = await serverFixture();
    try {
      let dropReply = true;
      const page = await host((async (...args: Parameters<typeof fetch>) => {
        const response = await server.fetcher(...args);
        if (dropReply && args[0] === "/proxy/ui/message") { dropReply = false; await response.json(); throw new Error("accepted HTTP reply lost"); }
        return response;
      }) as typeof fetch, server.url.origin, server.token);
      const params = { role: "user", content: [{ type: "text", text: "same text" }] };
      const first = page.bridge.onmessage(params);
      const context = page.bridge.onupdatemodelcontext({ content: [{ type: "text", text: "context" }] });
      await expect(first).rejects.toThrow("reply lost");
      expect(server.accepted).toHaveLength(1);
      expect(server.requests).toHaveLength(1);
      params.content[0]!.text = "mutated after failure";
      page.nodes.get("retry-action-btn").events.click();
      await context;
      await page.bridge.onmessage({ role: "user", content: [{ type: "text", text: "same text" }] });
      expect(server.requests.map(item => item.params.deliveryId)).toEqual([`ui:${sessionId}:1`, `ui:${sessionId}:1`, `ui:${sessionId}:2`, `ui:${sessionId}:3`]);
      expect(server.requests[1]!.params).toEqual(server.requests[0]!.params);
      expect(server.accepted.map(mail => mail.key)).toEqual([`ui:${sessionId}:1`, `ui:${sessionId}:2`, `ui:${sessionId}:3`]);
      expect(server.accepted.map(mail => mail.messages[0].customType)).toEqual(["mcp-ui-prompt", "mcp-ui-context", "mcp-ui-prompt"]);
      const conflict = await server.post("/proxy/ui/message", { ...server.requests[0]!.params, content: [{ type: "text", text: "changed" }] });
      expect(conflict.status).toBe(409);
      expect((await conflict.json() as any).error).toMatch(/conflict/);
      expect((await server.post("/proxy/ui/context", { content: [] })).status).toBe(400);
    } finally { await server.close(); }
  });

  it("raw put rejection is visible, ACKs failure, and retries only the same frozen action", async () => {
    const server = await serverFixture();
    try {
      server.reject = true;
      const page = await host(server.fetcher, server.url.origin, server.token);
      const data = { type: "prompt", payload: { prompt: "original" } };
      await page.raw(data);
      expect(page.nodes.get("error-message").textContent).toMatch(/was not accepted/);
      expect(page.replies).toEqual([expect.objectContaining({ deliveryId: `ui:${sessionId}:1`, accepted: false, error: expect.stringContaining("not accepted") })]);
      expect(server.accepted).toHaveLength(0);
      data.payload.prompt = "changed";
      server.reject = false;
      await page.raw({ type: "ui-message-retry", deliveryId: `ui:${sessionId}:1` });
      await until(() => page.replies.length === 2);
      expect(page.replies[1]).toEqual({ type: "ui-message-ack", deliveryId: `ui:${sessionId}:1`, accepted: true });
      expect(server.accepted).toHaveLength(1);
      expect(server.requests[1]!.params).toEqual(server.requests[0]!.params);
      expect(server.accepted[0].messages[0].details.prompt).toBe("original");
    } finally { await server.close(); }
  });
});
