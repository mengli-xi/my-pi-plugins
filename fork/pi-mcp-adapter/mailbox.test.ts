import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Mail, ProducerEndpoint } from "pi-session-inject/mailbox-v1";
import { captureMcpSender, proveMcpMail, readLegacyMcpEntries, uiNativeContent } from "./mailbox.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ctx = { sessionManager: { getLeafId: () => "anchor" } } as unknown as ExtensionContext;
const message = { customType: "mcp-ui-prompt", content: [{ type: "text" as const, text: "hello" }], display: true, details: { server: "test" } };
function endpoint(put: ProducerEndpoint["put"]) {
  const target = { slotKey: '["/agent","original"]', session: { id: "original", file: "/session.jsonl" }, bindingGeneration: 1, producerToken: Symbol() };
  return { target: () => target, put } as unknown as ProducerEndpoint;
}

describe("MCP mailbox adapter", () => {
  it("freezes native text/images and captures the original target before asynchronous work", async () => {
    const put = vi.fn(async () => ({ kind: "accepted" as const, key: "ui:window:1", revision: 1 }));
    const ep = endpoint(put);
    const sender = captureMcpSender(ep, ctx, () => true);
    const content = uiNativeContent("summary", [{ type: "text", text: "original" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
    const action = { ...message, content };
    const pending = sender(action, "ui:window:1");
    if (Array.isArray(content)) content.push({ type: "text", text: "changed after submission" });
    await pending;
    const [mail, target] = put.mock.calls[0] as unknown as [Mail, { session: { id: string } }];
    expect(mail.key).toBe("ui:window:1");
    expect(mail.policy).toBe("next-request");
    expect(mail.messages[0]!.content).toEqual([{ type: "text", text: "summary" }, { type: "text", text: "original" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(target.session.id).toBe("original");
  });
  it("keeps distinct UI actions in order and reports failed acceptance to the caller", async () => {
    const keys: string[] = [];
    const ep = endpoint(async mail => {
      keys.push(mail.key);
      if (keys.length === 1) throw new Error("disk full");
      return { kind: "accepted", key: mail.key, revision: 2 };
    });
    const sender = captureMcpSender(ep, ctx, () => true);
    const a = sender(message, "ui:window:1");
    const b = sender(message, "ui:window:2");
    await expect(a).rejects.toThrow("disk full");
    await b;
    expect(keys).toEqual(["ui:window:1", "ui:window:2"]);
  });
  it("never rehomes an OAuth result after owner retirement", async () => {
    const put = vi.fn();
    let active = true;
    const sender = captureMcpSender(endpoint(put), ctx, () => active);
    active = false;
    await expect(sender({ ...message, customType: "mcp-oauth-status" }, "oauth:server:attempt:authenticated")).rejects.toThrow("retired");
    expect(put).not.toHaveBeenCalled();
  });
  it("proves exact identity/content and treats legacy carriers only as history", () => {
    const sent = { ...message, details: { server: "test", deliveryId: "ui:window:1" } };
    const mail: Mail = { producer: "pi-mcp-adapter", key: "ui:window:1", anchorEntryId: "anchor", policy: "next-request", wake: true, messages: [sent] };
    const entry = { id: "native", type: "custom_message", ...sent } as unknown as SessionEntry;
    const legacy = { id: "old", type: "custom_message", ...message } as unknown as SessionEntry;
    expect(readLegacyMcpEntries([entry, legacy])).toEqual(["old"]);
    expect(proveMcpMail(mail, [entry, legacy])).toEqual({ kind: "observed", entries: [{ messageIndex: 0, entryId: "native" }] });
    expect(proveMcpMail(mail, [entry, entry]).kind).toBe("conflict");
    const mismatch = structuredClone(entry) as any;
    mismatch.content[0].text = "different";
    expect(proveMcpMail(mail, [mismatch]).kind).toBe("conflict");
    expect(proveMcpMail(mail, [legacy])).toEqual({ kind: "observed", entries: [] });
  });
  it("the unchanged stock session reader opens new carriers without replaying any App/auth action", () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-old-reader-"));
    try {
      const writer = SessionManager.create(directory, directory);
      writer.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
      writer.appendCustomMessageEntry("mcp-ui-prompt", message.content, true, { server: "test", prompt: "hello", deliveryId: "ui:window:1" });
      writer.appendCustomMessageEntry("mcp-oauth-status", message.content, true, { server: "test", status: "authenticated", deliveryId: "oauth:test:attempt:authenticated" });
      const branch = SessionManager.open(writer.getSessionFile()!).getBranch();
      const mail = branch.filter(entry => entry.type === "custom_message");
      expect(mail.map(entry => entry.customType)).toEqual(["mcp-ui-prompt", "mcp-oauth-status"]);
      expect(mail[0]!.details).toEqual({ server: "test", prompt: "hello", deliveryId: "ui:window:1" });
      expect(mail[0]!.content).toEqual(message.content);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
