import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { bindMailbox } from "pi-session-inject/mailbox-v1";
import schedulerExtension from "../../index.ts";
import { schedulerProducer, injectionMail, INJECTION_TYPE } from "../../src/mailbox-adapter.ts";
import { putSchedulerIntent } from "../../src/mailbox-delivery.ts";
import { importSchedulerBranch } from "../../src/mailbox-import.ts";
import { request } from "../../src/client.ts";

const config = JSON.parse(readFileSync(process.env.SCHEDULER_JOINT_CONFIG!, "utf8"));
const log = (value: object) => appendFileSync(config.log, JSON.stringify({ phase: config.phase, ...value }) + "\n");
const waitFile = async (name: string, signal?: AbortSignal) => {
  const until = Date.now() + 20000;
  while (!existsSync(`${config.directory}/${name}`) && !signal?.aborted) {
    if (Date.now() > until) throw new Error(`joint gate timeout: ${name}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
export default function (pi: any): void {
  const faux = fauxProvider({ provider: "scheduler-joint", api: "scheduler-joint", models: [{ id: "faux", reasoning: false, contextWindow: 100000, maxTokens: 256 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 16 }, () => async (context, options, state) => {
    log({ stage: "request", call: state.callCount, messages: context.messages });
    if (["abort", "unknown-crash", "cancel-flight"].includes(config.scenario)) await waitFile("provider-release", options?.signal);
    if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
    if (config.scenario === "error") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "joint faux error" });
    return fauxAssistantMessage(`JOINT_DONE_${state.callCount}`);
  }));
  pi.registerProvider(faux.provider);
  const native = pi.sendMessage.bind(pi);
  pi.sendMessage = (message: any, options: any) => { log({ stage: "native-send", customType: message.customType, options }); return native(message, options); };
  let ctx: any, endpoint: any;
  let entryIds: string[] = [];
  const entryCompletions = (prefix: string) => {
    const items = entryIds.filter(id => id.startsWith(prefix)).map(id => ({ value: id, label: id }));
    return items.length ? items : null;
  };
  const intents = new Map();
  const send = (body: any) => request(body, { socketPath: config.socket });
  async function deliver(context: any, gated = false, navigateWhilePut = false): Promise<void> {
    const target = endpoint.target(context), branch = context.sessionManager.getBranch(), leafId = context.sessionManager.getLeafId();
    const nativeProofs = branch.filter((e: any) => e.type === "custom_message" && e.customType === INJECTION_TYPE).map((e: any) => ({
      injectionId: e.details.injection_id, entryId: e.id, anchorEntryId: e.parentId,
      message: { customType: e.customType, content: e.content, display: e.display, details: e.details },
    }));
    const reply: any = await send({ type: "injection.offers", sessionId: target.session.id, pid: process.pid,
      holderToken: "joint-holder", bindingGen: 10, anchorEntryId: leafId, nativeProofs });
    if (!reply.ok) throw new Error(reply.error);
    log({ stage: "offers", reply, target, leafId });
    if (gated) { log({ stage: "source-prepared" }); await waitFile("put-release"); }
    const imported = await importSchedulerBranch({ branch, offers: reply.offers, unknownIds: new Set(reply.unknown.map((v: any) => v.injectionId)), endpoint, target, send,
      diagnostic: (reason) => log({ stage: "diagnostic", reason }) });
    for (const offer of reply.offers) {
      if (imported.has(offer.injectionId)) continue;
      try {
        const ingress = putSchedulerIntent({ endpoint, mail: injectionMail(offer), recovered: offer.recovered !== false, target, intents, branch, leafId });
        const navigation = navigateWhilePut ? context.navigateTree("sibling-fixture", { summarize: false }) : null;
        const result = await ingress;
        log({ stage: "put-result", result });
        if (navigation) { await navigation; log({ stage: "navigate", leaf: context.sessionManager.getLeafId(), target: endpoint.target(context), branchIds: context.sessionManager.getBranch().map((e: any) => e.id) }); }
      } catch (error: any) { log({ stage: "put-error", code: error.code, error: String(error) }); }
    }
    log({ stage: "delivery-done" });
  }
  if (config.full) schedulerExtension(pi);
  else {
    const installPeer = () => bindMailbox(pi).registerProducer({ id: "scheduler-test-peer",
      checkCurrent: () => ({ kind: "allow", project: true, wake: true }), proveNative: () => ({ kind: "observed", entries: [] }) });
    if (config.scenario === "owner-before") installPeer();
    const binding = bindMailbox(pi);
    if (config.scenario === "source-disabled" && config.phase === 1) {
      binding.registerProducer({ id: "scheduler-test-peer", checkCurrent: () => ({ kind: "allow", project: true, wake: true }), proveNative: () => ({ kind: "observed", entries: [] }) });
    } else {
      const source = schedulerProducer(send, (key, reason, fence) => endpoint.cancel(key, reason, fence), () => ctx?.sessionManager.getBranch());
      endpoint = binding.registerProducer({ ...source,
        async onRecorded(notice: any, fence: any) {
          log({ stage: "recorded-start", notice });
          await source.onRecorded!(notice, fence);
          log({ stage: "recorded-commit", notice });
          if (["recorded-lost", "legacy-recorded-lost"].includes(config.scenario) && config.phase === 1) throw new Error("joint lost recorded callback reply");
          if (config.scenario === "cancel-flight") {
            await waitFile("cancel-go");
            const evidence = await endpoint.cancel(notice.key, "joint-business-cancel", fence);
            log({ stage: "cancel-durable", evidence });
            await waitFile("recorded-release");
          }
        },
        async onTerminal(evidence: any, fence: any) {
          log({ stage: "terminal-start", evidence });
          await source.onTerminal!(evidence, fence);
          log({ stage: "terminal-commit", evidence });
          if (config.scenario === "ack-lost" && config.phase === 1) throw new Error("joint lost final ACK callback reply");
          if (["reopen", "fork-parent"].includes(config.scenario) && !existsSync(`${config.directory}/allow-reopen`)) throw new Error("joint original binding lost final ACK reply");
          if (config.scenario === "ack-snapshot-lost" && config.phase === 1) {
            log({ stage: "terminal-wait" }); await waitFile("allow-terminal"); log({ stage: "terminal-return" });
          }
        },
        async beforeRun(start: any) {
          ctx = start.ctx;
          log({ stage: "before-run", automatic: start.automatic, members: start.members.map((m: any) => m.mail.key) });
          await source.beforeRun!(start);
          if (config.scenario === "late" && !config.lateDone) { config.lateDone = true; await deliver(start.ctx); }
        },
        async afterRun(end: any) { log({ stage: "after-run", outcome: end.outcome, members: end.members.map((m: any) => m.mail.key) }); await source.afterRun!(end); },
      });
    }
    if (config.scenario === "owner-after") installPeer();
  }
  pi.on("session_start", async (_event: any, context: any) => {
    ctx = context;
    entryIds = ctx.sessionManager.getEntries().map((e: any) => e.id);
    if (!config.full && endpoint) {
      await send({ type: "occupancy.register", sessionId: ctx.sessionManager.getSessionId(), pid: process.pid, holderToken: "joint-holder", bindingGen: 10 });
      await send({ type: "occupancy.unregister", sessionId: ctx.sessionManager.getSessionId(), pid: config.driverPid, holderToken: "driver", bindingGen: 1 });
    }
    if (config.full && ["full-normal", "full-batch", "full-recovered-source"].includes(config.scenario)) await send({ type: "occupancy.unregister", sessionId: ctx.sessionManager.getSessionId(), pid: config.driverPid, holderToken: "driver", bindingGen: 1 });
    log({ stage: "ready", sessionId: ctx.sessionManager.getSessionId(), target: endpoint?.target(ctx), leaf: ctx.sessionManager.getLeafId(), entryCompletions: { empty: entryCompletions(""), partial: entryCompletions(entryIds[0]?.slice(0, 3) ?? ""), unknown: entryCompletions("__unknown_entry__") }, mailboxCommands: pi.getCommands().filter((c: any) => c.name.startsWith("mailbox")).map((c: any) => c.name) });
  });
  pi.on("session_tree", (_event: any, context: any) => { ctx = context; entryIds = ctx.sessionManager.getEntries().map((e: any) => e.id); log({ stage: "tree", leaf: ctx.sessionManager.getLeafId(), target: endpoint?.target(ctx) }); });
  pi.on("agent_settled", (_event: any, context: any) => { ctx = context; log({ stage: "settled", calls: faux.state.callCount }); });
  pi.registerCommand("joint-deliver", { handler: async (_args: string, context: any) => { await deliver(context); } });
  const switched = (context: any) => log({ stage: "switched", sessionId: context.sessionManager.getSessionId(), file: context.sessionManager.getSessionFile() });
  pi.registerCommand("joint-away", { handler: async (_args: string, context: any) => { await context.switchSession(config.otherFile, { withSession: switched }); } });
  pi.registerCommand("joint-fork", { handler: async (_args: string, context: any) => { await context.fork("assistant-fixture", { position: "at", withSession: switched }); } });
  pi.registerCommand("joint-back", { handler: async (_args: string, context: any) => { await context.switchSession(config.parentFile, { withSession: switched }); } });
  pi.registerCommand("joint-conflict", { handler: async () => {
    const marker = await send({ type: "injection.current", injectionId: "mailbox-contract-fixture:1800000000000", sessionId: config.parentSessionId });
    if (!marker.ok || marker.type !== "injection-current" || !marker.marker) throw new Error("missing conflict source");
    const m = marker.marker;
    const carrier = { customType: INJECTION_TYPE, content: m.prompt, display: true, details: { version: 1, injection_id: m.injectionId, task_id: m.taskId, title: m.title, scheduled_time: m.scheduledTime } };
    pi.sendMessage(carrier, { triggerTurn: false }); pi.sendMessage(carrier, { triggerTurn: false });
    log({ stage: "conflict-ready" });
  } });
  pi.registerCommand("joint-stage", { handler: async (_args: string, context: any) => { void deliver(context, true).catch(error => log({ stage: "delivery-error", error: String(error) })); } });
  pi.registerCommand("joint-ingress-tree", { handler: async (_args: string, context: any) => { await deliver(context, false, true); } });
  pi.registerCommand("joint-entry", { description: "Navigate to a real session entry ID for joint scope checks",
    getArgumentCompletions: entryCompletions,
    handler: async (args: string, context: any) => { const id = args.trim(); if (!entryIds.includes(id)) throw new Error("unknown session entry ID"); const result = await context.navigateTree(id, { summarize: false }); log({ stage: "navigate", result, leaf: context.sessionManager.getLeafId(), target: endpoint?.target(context) }); } });
  pi.registerCommand("joint-origin", { handler: async (_args: string, context: any) => { const result = await context.navigateTree("origin-fixture", { summarize: false }); log({ stage: "navigate", result, leaf: context.sessionManager.getLeafId(), target: endpoint?.target(context) }); } });
  pi.registerCommand("joint-sibling", { handler: async (_args: string, context: any) => { const result = await context.navigateTree("sibling-fixture", { summarize: false }); log({ stage: "navigate", result, leaf: context.sessionManager.getLeafId(), target: endpoint?.target(context) }); } });
}
