import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createMcpAdapter } from "../fork/pi-mcp-adapter/index.ts";
import { IMAGE, assertDurableFile, assertMailboxAccepted, collaborators, componentProducer, mcpFixture, text, until } from "./mcp/harness.ts";
import { appServer, uiPost } from "./mcp/server.ts";

for (const order of ["mcp-first", "mcp-last", "without-collaborators"] as const) {
  test(`full createMcpAdapter App → real Inject projection (${order})`, async () => {
    const f = mcpFixture();
    const server = await appServer();
    const adapter = createMcpAdapter({ config: { mcpServers: { demo: { url: server.url, directTools: false, lifecycle: "eager", approveTools: false } },
      settings: { directTools: false, namespaceProxyTools: false, sampling: false, elicitation: false } } });
    let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
    try {
      const peers = order === "without-collaborators" ? [] : await collaborators();
      runtime = await f.start(order === "mcp-last" ? [...peers, adapter] : [adapter, ...peers]);
      let opened = false;
      f.respond(() => {
        if (!opened) { opened = true; return fauxAssistantMessage(fauxToolCall("mcp", { tool: "demo_app", args: {} })); }
        return fauxAssistantMessage("APP_FACTORY_OK");
      });
      await runtime.session.prompt("Open the fixture App", { source: "rpc" });
      const result = runtime.session.messages.find(message => message.role === "toolResult" && typeof (message.details as { uiUrl?: unknown } | undefined)?.uiUrl === "string");
      assert.ok(result && result.role === "toolResult", JSON.stringify(runtime.session.messages));
      const url = (result.details as { uiUrl: string }).uiUrl;
      assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "the App host is loopback-only");
      assert.ok(server.calls.includes("resources/read"), "the full factory read its actual MCP App resource");
      assert.equal(server.calls.filter(method => method === "tools/call").length, 1);
      const baseline = f.requests.length;
      const deliveryId = `ui:factory-${order}:1`;
      const params = { deliveryId, role: "user", content: [{ type: "text", text: `FACTORY_APP_${order}` }, { type: "image", data: IMAGE, mimeType: "image/png" }] };
      const response = await uiPost(url, "message", params);
      assert.equal(response.status, 200, await response.text());
      assertMailboxAccepted(f.agentDir, runtime.session.sessionManager, deliveryId);
      // HTTP success must already correspond to the real fsynced shared put.
      const duplicate = await uiPost(url, "message", params);
      assert.equal(duplicate.status, 200, await duplicate.text());
      await until(() => f.requests.slice(baseline).some(messages => messages.some(message => text(message).includes(`FACTORY_APP_${order}`))), "App native provider projection");
      await runtime.session.waitForIdle();
      const native = runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-ui-prompt");
      assert.equal(native.length, 1, "accepted-but-repeated HTTP action emits exactly one native carrier");
      assert.deepEqual((native[0] as any).content.slice(-2), params.content, "App native image bytes and text survive the real transport");
      assertDurableFile(runtime.session.sessionManager, deliveryId);
      const conflict = await uiPost(url, "message", { ...params, content: [{ type: "text", text: "changed" }] });
      assert.equal(conflict.status, 409);
      assert.equal(server.calls.filter(method => method === "tools/call").length, 1, "delivery retries never repeat an MCP tool call");
      assert.equal(f.requests.length, baseline + 1, "the duplicate cannot create a second agent run");
      assert.deepEqual(server.errors, []);
      assert.deepEqual(f.errors, []);
    } finally { await runtime?.dispose(); await server.close(); f.cleanup(); }
  });
}

test("full factory consent revocation survives manager replacement and holds accepted App mail until explicit reapproval", async () => {
  const f = mcpFixture();
  const server = await appServer();
  const adapter = createMcpAdapter({ config: { mcpServers: { demo: { url: server.url, directTools: false, lifecycle: "eager", approveTools: false } },
    settings: { directTools: false, namespaceProxyTools: false, sampling: false, elicitation: false } } });
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([adapter]);
    let opened = false;
    f.respond(() => !opened ? (opened = true, fauxAssistantMessage(fauxToolCall("mcp", { tool: "demo_app", args: {} }))) : fauxAssistantMessage("APP_OK"));
    await runtime.session.prompt("Open", { source: "rpc" });
    const result = runtime.session.messages.find(message => message.role === "toolResult" && typeof (message.details as { uiUrl?: unknown } | undefined)?.uiUrl === "string") as any;
    assert.ok(result?.details?.uiUrl);
    const url = result.details.uiUrl;
    assert.equal((await uiPost(url, "consent", { approved: false })).status, 200);
    const deliveryId = "ui:consent:1";
    assert.equal((await uiPost(url, "message", { deliveryId, role: "user", content: [{ type: "text", text: "REVOKED_APP_BODY" }] })).status, 200);
    const baseline = f.requests.length;
    await runtime.session.prompt("Ordinary input while App is denied", { source: "rpc" });
    assert.equal(f.requests.length, baseline + 1);
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes("REVOKED_APP_BODY"));
    const file = runtime.session.sessionManager.getSessionFile()!;
    await runtime.dispose();
    runtime = await f.start([adapter], SessionManager.open(file));
    assert.equal(f.requests.length, baseline + 1, "factory recovery does not authorize another provider request");
    assert.equal(server.calls.filter(method => method === "tools/call").length, 1, "factory recovery must not replay the App's original tool call");
    await runtime.session.prompt("Still denied after restore", { source: "rpc" });
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes("REVOKED_APP_BODY"), "restored consent remains a source guard, not just a lost UI flag");
    opened = false;
    await runtime.session.prompt("Explicitly reopen the App to review consent", { source: "rpc" });
    const reopened = runtime.session.messages.findLast(message => message.role === "toolResult" && typeof (message.details as { uiUrl?: unknown } | undefined)?.uiUrl === "string") as any;
    assert.ok(reopened?.details?.uiUrl);
    assert.equal((await uiPost(reopened.details.uiUrl, "consent", { approved: true })).status, 200);
    await runtime.session.prompt("Consent restored", { source: "rpc" });
    await until(() => JSON.stringify(f.requests.at(-1)).includes("REVOKED_APP_BODY"), "consent-restored projection");
    assert.equal(runtime.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mcp-ui-prompt").length, 1);
    assertDurableFile(runtime.session.sessionManager, deliveryId);
    assert.deepEqual(f.errors, []);
  } finally { await runtime?.dispose(); await server.close(); f.cleanup(); }
});

test("adapter component OAuth/App captures use real durable transport; disabled source holds, replacement manager recovers without auth/tool replay", async () => {
  const f = mcpFixture();
  const first = componentProducer();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    runtime = await f.start([first.factory]);
    await runtime.session.prompt("Seed persistent session", { source: "rpc" });
    (first.state.config.mcpServers.demo as any).disabled = true;
    const sender = first.sender();
    await sender(first.message("oauth", "OAUTH_OUTCOME_ALREADY_OBTAINED"), "oauth:demo:attempt:failed");
    await sender(first.message("prompt", "RECOVER_APP_ONCE"), "ui:recovery:1");
    assertMailboxAccepted(f.agentDir, runtime.session.sessionManager, "oauth:demo:attempt:failed");
    assertMailboxAccepted(f.agentDir, runtime.session.sessionManager, "ui:recovery:1");
    const baseline = f.requests.length;
    await runtime.session.prompt("Disabled source must not leak", { source: "rpc" });
    assert.equal(f.requests.length, baseline + 1);
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes("OAUTH_OUTCOME_ALREADY_OBTAINED"));
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes("RECOVER_APP_ONCE"));
    const file = runtime.session.sessionManager.getSessionFile()!;
    await runtime.dispose();
    const second = componentProducer();
    runtime = await f.start([second.factory], SessionManager.open(file));
    assert.equal(f.requests.length, baseline + 1, "opening recovery is not authorization for a run");
    await runtime.session.prompt("Trusted input releases recovered mail", { source: "rpc" });
    await until(() => JSON.stringify(f.requests.at(-1)).includes("RECOVER_APP_ONCE"), "recovered source bodies");
    const serialized = JSON.stringify(f.requests.at(-1));
    assert.ok(serialized.includes("OAUTH_OUTCOME_ALREADY_OBTAINED"));
    assert.ok(serialized.includes(IMAGE));
    const entries = runtime.session.sessionManager.getBranch();
    assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "mcp-ui-prompt").length, 1);
    assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "mcp-oauth-status").length, 1);
    assertDurableFile(runtime.session.sessionManager, "oauth:demo:attempt:failed");
    assert.deepEqual(f.errors, []);
  } finally { await runtime?.dispose(); f.cleanup(); }
});
