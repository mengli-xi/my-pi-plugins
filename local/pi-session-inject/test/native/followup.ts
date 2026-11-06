import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bindMailbox, type MailboxBinding } from "../../src/mailbox-v1/index.js";

type GoalFactory = (pi: ExtensionAPI, options: { mailbox: MailboxBinding }) => void;
export default function followup(pi: ExtensionAPI, goal?: GoalFactory): void {
  const scenario = process.env.MAILBOX_FOLLOWUP_SCENARIO;
  const log = (value: unknown) => appendFileSync(process.env.MAILBOX_NATIVE_LOG!, JSON.stringify(value) + "\n");
  const faux = fauxProvider({ provider: "mailbox-faux", api: "mailbox-faux", models: [{ id: "fixture", reasoning: false, contextWindow: 32768, maxTokens: 512 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 8 }, () => async (context, _options, state) => {
    log({ stage: "request", call: state.callCount, messages: context.messages });
    if (scenario === "natural" && state.callCount === 1) return fauxAssistantMessage(fauxToolCall("mailtest_natural", {}));
    if (scenario === "goal" && state.callCount === 2) {
      const text = context.messages.map(message => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
      const id = [...text.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)].at(-1)?.[1];
      if (!id) throw new Error("missing goal_id in continuation request");
      return fauxAssistantMessage(fauxToolCall("goal_complete", { goal_id: id, summary: "Completed isolated regression." }));
    }
    return fauxAssistantMessage(`DONE_${state.callCount}`);
  }));
  pi.registerProvider(faux.provider);
  const binding = bindMailbox(pi);
  if (scenario === "goal") {
    if (!goal) throw new Error("real Goal bundle is required"); goal(pi, { mailbox: binding });
  } else {
    let repaired = false, put = false, original: string | null = null, forkPoint: string | null = null;
    const producer = scenario === "fork-return" ? "pi-mcp-adapter" : "pi-processes";
    const endpoint = binding.registerProducer({ id: producer, checkCurrent: () => ({ kind: "allow", project: true, wake: scenario !== "fork-return" }),
      proveNative: (mail, branch) => !repaired && scenario === "proof-conflict" ? { kind: "conflict", reason: "native collision fixture" } : { kind: "observed", entries: mail.messages.flatMap((carrier, messageIndex) => {
        const matches = branch.filter(entry => entry.type === "custom_message" && entry.customType === carrier.customType && entry.content === carrier.content);
        return matches[0] ? [{ messageIndex, entryId: matches[0].id }] : [];
      }) },
      onTerminal: evidence => { log({ stage: "terminal", evidence }); },
      ...(scenario === "fork-return" ? { onRecorded: async () => { log({ stage: "recorded" }); } } : {}),
      settled: async (_event, ctx) => {
        if (scenario !== "proof-conflict" || put) return;
        put = true; await endpoint.put({ producer: "pi-processes", key: "proof-conflict", anchorEntryId: ctx.sessionManager.getLeafId(), policy: "new-run", wake: true,
          messages: [{ customType: "proof-body", content: "PROOF_BODY", display: false }] });
        log({ stage: "conflict-put" });
      },
    });
    pi.on("session_start", (_event, ctx) => { original ??= ctx.sessionManager.getSessionFile() ?? null;
      log({ stage: "start", sessionId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), anchorEntryId: ctx.sessionManager.getLeafId() }); });
    if (scenario === "late-writer") pi.registerCommand("mailtest-live-put", { handler: async (_args, ctx) => {
      await endpoint.put({ producer: "pi-processes", key: "new-this-process", anchorEntryId: ctx.sessionManager.getLeafId(), policy: "next-request", wake: true,
        messages: [{ customType: "proof-body", content: "NEW_THIS_PROCESS", display: false }] }, endpoint.target(ctx));
    } });
    if (scenario === "fork-return") {
      bindMailbox(pi).registerProducer({ id: "pi-scheduler", checkCurrent: () => ({ kind: "hold", reason: "peer fixture" }), proveNative: () => ({ kind: "observed", entries: [] }) });
      pi.registerCommand("mailtest-fork-seed", { handler: async (_args, ctx) => {
        forkPoint = ctx.sessionManager.getLeafId();
        await endpoint.put({ producer: "pi-mcp-adapter", key: "fork-parent-pending", anchorEntryId: forkPoint, policy: "next-request", wake: false,
          messages: [{ customType: "mc-ceiling-nudge-v1", content: "PARENT_MC_PENDING", display: false }] }, endpoint.target(ctx));
        log({ stage: "fork-seeded" });
      } });
      pi.registerCommand("mailtest-fork-return", { handler: async (_args, ctx) => {
        await ctx.fork(forkPoint!, { position: "at", withSession: async child => {
          log({ stage: "fork-child", sessionId: child.sessionManager.getSessionId(), bodies: child.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "mc-ceiling-nudge-v1").length });
          await child.switchSession(original!, { withSession: async parent => { log({ stage: "returned", sessionId: parent.sessionManager.getSessionId() }); } });
        } });
      } });
    }
    pi.registerCommand("mailtest-return", { handler: async (_args, ctx) => {
      await ctx.newSession({ withSession: async next => {
        await next.switchSession(original!, { withSession: async () => { log({ stage: "returned" }); } });
      } });
    } });
    // The command context is recreated by public switchSession. Capture the new
    // session_start context instead of reusing a command's retired context.
    let currentCtx: ExtensionContext;
    pi.on("session_start", (_event, ctx) => { currentCtx = ctx; });
    if (scenario === "natural") pi.registerTool({ name: "mailtest_natural", label: "Mailtest natural", description: "Deliver fixture mail before a natural tool continuation", parameters: Type.Object({}),
      execute: async () => {
        await endpoint.put({ producer: "pi-processes", key: "natural", anchorEntryId: currentCtx.sessionManager.getLeafId(), policy: "next-request", wake: true,
          messages: [{ customType: "proof-body", content: "NATURAL_BODY", display: false }] });
        return { content: [{ type: "text", text: "Fixture tool completed" }], details: {} };
      } });
    pi.registerCommand("mailtest-target", { handler: async () => { log({ stage: "target", sessionId: endpoint.target(currentCtx).session.id }); } });
    pi.registerCommand("mailtest-repair", { handler: async () => { repaired = true; log({ stage: "repaired" }); } });
  }
  pi.on("agent_settled", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const state = entries.filter(entry => entry.type === "custom" && entry.customType === "goal-state").at(-1);
    log({ stage: "settled", calls: faux.state.callCount, goal: state?.type === "custom" ? state.data : null,
      bodies: entries.filter(entry => entry.type === "custom_message" && ["goal-mailbox-continuation-v1", "proof-body", "mc-ceiling-nudge-v1"].includes(entry.customType)).length,
      controls: entries.filter(entry => entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1").length });
  });
}
