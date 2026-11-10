import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { bindMailbox, type Mail, type MailboxCallbackFence, type NativeMailMessage, type ProducerEndpoint } from "pi-session-inject/mailbox-v1/light";
import type { McpExtensionState } from "./state.ts";

const TYPES = new Set(["mcp-ui-prompt", "mcp-ui-intent", "mcp-ui-context", "mcp-oauth-status", "mcp-task-result"]);
export interface McpMailSender {
  (message: NativeMailMessage, deliveryId?: string): Promise<void>;
  /** Source lineage observation; unlike a transport target it survives shutdown handoff. */
  isCurrent?: () => boolean;
}
export interface McpMailCaptureOptions {
  anchorEntryId?: string | null;
  recovered?: true;
}

function nativeMessage(entry: SessionEntry) {
  if (entry.type === "custom_message") return entry;
  // Historical SessionMessageEntry projections may still carry a custom role.
  return entry.type === "message" && entry.message.role === "custom" ? entry.message : null;
}

// Legacy entries are history, never instructions to repeat a click, OAuth, or Task.
export function readLegacyMcpEntries(branch: readonly SessionEntry[]): string[] {
  return branch.filter(entry => {
    const message = nativeMessage(entry);
    return message && TYPES.has(message.customType) && !(message.details as { deliveryId?: unknown } | undefined)?.deliveryId;
  }).map(entry => entry.id);
}

export function proveMcpMail(mail: Mail, branch: readonly SessionEntry[]) {
  const entries: { messageIndex: number; entryId: string }[] = [];
  for (const [messageIndex, message] of mail.messages.entries()) {
    const id = (message.details as { deliveryId?: unknown } | undefined)?.deliveryId;
    const matches = branch.filter(entry => {
      const native = nativeMessage(entry);
      return native && (native.details as { deliveryId?: unknown } | undefined)?.deliveryId === id;
    });
    if (typeof id !== "string" || matches.length > 1) return { kind: "conflict" as const, reason: "Invalid or duplicate MCP delivery ID" };
    for (const entry of matches) {
      const native = nativeMessage(entry)!;
      if (native.customType !== message.customType || native.display !== message.display || JSON.stringify(native.content) !== JSON.stringify(message.content)
        || JSON.stringify(native.details) !== JSON.stringify(message.details)) {
        return { kind: "conflict" as const, reason: "MCP delivery ID payload mismatch" };
      }
      entries.push({ messageIndex, entryId: entry.id });
    }
  }
  return { kind: "observed" as const, entries };
}

export function createMcpMailbox(pi: ExtensionAPI, current: (fence: MailboxCallbackFence) => McpExtensionState | null | Promise<McpExtensionState | null>) {
  const binding = bindMailbox(pi);
  // MCP Tasks persist their own unaccepted outcome/reference. Public session_tree
  // changes invalidate that source scope even when the anchor is a shared ancestor.
  // Keep this observation independent of target(), which is retired before some
  // session_shutdown callbacks. Unknown/mismatched scopes remain held at origin.
  let treeRevision = 0;
  const releaseTree = pi.on("session_tree", () => { treeRevision++; });
  const endpoint = binding.registerProducer({
    id: "pi-mcp-adapter",
    async checkCurrent(mail, _point, fence) {
      const state = await current(fence);
      if (!state?.owner.isActive()) return { kind: "hold", reason: "MCP runtime is not ready" };
      for (const message of mail.messages) {
        const details = message.details as { server?: string; deliveryId?: string; status?: string } | undefined;
        if (!TYPES.has(message.customType) || !details?.deliveryId || !details.server) return { kind: "hold", reason: "Unrecognized MCP mail" };
        const server = state.config.mcpServers[details.server];
        if (!server || server.disabled === true || state.blockedProjectServers?.has(details.server)) {
          return { kind: "hold", reason: "MCP server is disabled or requires approval" };
        }
        if (message.customType.startsWith("mcp-ui-") && state.consentManager.isDenied(details.server)) {
          return { kind: "hold", reason: "MCP App consent was revoked" };
        }
        if (message.customType === "mcp-oauth-status" && details.status === "authenticated") {
          try {
            const [{ inspectAuthForUrl }, { resolveServerUrl }] = await Promise.all([import("./mcp-auth.ts"), import("./utils.ts")]);
            if (!state.owner.isActive()) return { kind: "hold", reason: "MCP runtime is not ready" };
            const currentServer = state.config.mcpServers[details.server];
            if (!currentServer || currentServer.disabled === true || state.blockedProjectServers?.has(details.server)) {
              return { kind: "hold", reason: "MCP server is disabled or requires approval" };
            }
            const serverUrl = resolveServerUrl(currentServer);
            if (!serverUrl) return { kind: "hold", reason: "MCP OAuth server URL is unavailable" };
            // Mail delivery only observes current credentials: never authenticate,
            // refresh, trust the credential cache, or migrate/delete legacy data.
            const auth = inspectAuthForUrl(details.server, serverUrl, state.authStorageOptions);
            if (auth.status === "unavailable") return { kind: "hold", reason: "MCP OAuth credential store is unavailable" };
            if (auth.status === "absent" || (auth.status === "present" && (!auth.entry.tokens?.accessToken
              || (auth.entry.tokens.expiresAt !== undefined && auth.entry.tokens.expiresAt <= Date.now() / 1000)))) {
              return { kind: "cancel", reason: "MCP OAuth authentication is no longer current" };
            }
            if (auth.status !== "present") return { kind: "hold", reason: "MCP OAuth status is unknown" };
          } catch {
            return { kind: "hold", reason: "MCP OAuth status could not be inspected" };
          }
        }
      }
      return { kind: "allow", project: true, wake: true };
    },
    proveNative: proveMcpMail,
  });
  return {
    capture(ctx: ExtensionContext, active: () => boolean, options: McpMailCaptureOptions = {}): McpMailSender {
      const revision = treeRevision;
      const anchor = options.anchorEntryId === undefined ? ctx.sessionManager.getLeafId() : options.anchorEntryId;
      return captureMcpSender(endpoint, ctx, active, options,
        () => treeRevision === revision || ctx.sessionManager.getLeafId() === anchor);
    },
    close: () => { if (typeof releaseTree === "function") releaseTree(); binding.close(); },
  };
}

export function captureMcpSender(endpoint: ProducerEndpoint, ctx: ExtensionContext, active: () => boolean, options: McpMailCaptureOptions = {}, sourceIsCurrent?: () => boolean): McpMailSender {
  let target = endpoint.target(ctx);
  const anchorEntryId = options.anchorEntryId === undefined ? ctx.sessionManager.getLeafId() : options.anchorEntryId;
  // Calls enter the durable writer in UI action order; failed acceptance rejects
  // that action and leaves the following action able to proceed.
  let tail = Promise.resolve();
  const send: McpMailSender = (message, deliveryId = randomUUID()) => {
    const frozen = structuredClone({ ...message, details: { ...(message.details as object ?? {}), deliveryId } });
    const mail: Mail = { producer: "pi-mcp-adapter", key: deliveryId, anchorEntryId,
      policy: "next-request", wake: true, messages: [frozen] };
    const result = tail.then(async () => {
      if (!active()) throw new Error("MCP action belongs to a retired runtime");
      const current = endpoint.target(ctx);
      if (current.bindingGeneration !== target.bindingGeneration) {
        // A tree boundary invalidates this UI/auth operation. Only an explicit
        // return to its original leaf permits rebuilding the same source scope.
        // Never let a shared ancestor on a sibling authorize a new target.
        if (current.slotKey !== target.slotKey || ctx.sessionManager.getLeafId() !== anchorEntryId) {
          throw new Error("MCP action is held for its original tree scope; action was not accepted");
        }
        target = current;
      }
      if (options.recovered) await endpoint.put(mail, target, { recovered: true });
      else await endpoint.put(mail, target);
    });
    tail = result.catch(() => {});
    return result;
  };
  send.isCurrent = sourceIsCurrent ?? (() => {
    try {
      const current = endpoint.target(ctx);
      return current.slotKey === target.slotKey && (current.bindingGeneration === target.bindingGeneration
        || ctx.sessionManager.getLeafId() === anchorEntryId);
    } catch { return false; }
  });
  return send;
}

/** Preserve native image blocks; the summary is additional context, never a
 * replacement for the text/image array supplied by the App. */
export function uiNativeContent(summary: string, content: readonly unknown[] | undefined): NativeMailMessage["content"] {
  const parts: Exclude<NativeMailMessage["content"], string> = [{ type: "text", text: summary }];
  for (const item of content ?? []) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text });
    if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      parts.push({ type: "image", data: part.data, mimeType: part.mimeType });
    }
  }
  return parts;
}
