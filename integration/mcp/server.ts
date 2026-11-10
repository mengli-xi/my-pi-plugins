import { createServer } from "node:http";
import { once } from "node:events";
import { InitializeResultSchema, ListToolsResultSchema, ListResourcesResultSchema, ListPromptsResultSchema, ReadResourceResultSchema, CallToolResultSchema } from "@modelcontextprotocol/core";

/** Offline test server, not a remote MCP service or Tasks implementation.
 * Responses are parsed by the official SDK 2.3.1 schemas before going on the wire.
 * It deliberately negotiates the ordinary 2025-11-25 protocol, without ext-tasks. */
export async function appServer() {
  const calls: string[] = [];
  const tool = { name: "app", description: "Open the offline App", inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://fixture/app" } } };
  const errors: Error[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
      calls.push(rpc.method);
      let result: unknown;
      switch (rpc.method) {
        case "initialize": result = InitializeResultSchema.parse({ protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "offline-app-fixture", version: "1" } }); break;
        case "tools/list": result = ListToolsResultSchema.parse({ tools: [tool] }); break;
        case "resources/list": result = ListResourcesResultSchema.parse({ resources: [] }); break;
        case "prompts/list": result = ListPromptsResultSchema.parse({ prompts: [] }); break;
        case "resources/read": result = ReadResourceResultSchema.parse({ contents: [{ uri: "ui://fixture/app", mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>Offline MCP App fixture</p>" }] }); break;
        case "tools/call": result = CallToolResultSchema.parse({ content: [{ type: "text", text: "APP_OPENED" }] }); break;
        case "ping": result = {}; break;
        default:
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Fixture method not found" } }));
          return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch (error) {
      errors.push(error as Error);
      response.writeHead(500); response.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls, errors,
    async close() { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); } };
}

export async function uiPost(url: string, route: string, params: Record<string, unknown>) {
  const target = new URL(url);
  return fetch(new URL(`/proxy/ui/${route}`, target), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: target.searchParams.get("session"), params }) });
}
