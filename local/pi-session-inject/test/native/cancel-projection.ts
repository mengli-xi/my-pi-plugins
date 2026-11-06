import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindMailbox, type Mail } from "../../src/mailbox-v1/light.js";
import { sharedCarrierFixture } from "../fixtures/shared-carrier.js";

export default function cancelProjection(pi: ExtensionAPI): void {
  const log = (value: unknown) => appendFileSync(process.env.MAILBOX_NATIVE_LOG!, JSON.stringify(value) + "\n");
  const faux = fauxProvider({ provider: "mailbox-faux", api: "mailbox-faux", models: [{ id: "fixture", reasoning: false, contextWindow: 32768, maxTokens: 512 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 8 }, () => async (context, _options, state) => {
    log({ stage: "request", call: state.callCount, messages: context.messages });
    return fauxAssistantMessage(`DONE_${state.callCount}`);
  }));
  pi.registerProvider(faux.provider);
  let ctx: ExtensionContext, mail: Mail | undefined;
  // On restart only a peer is enabled: cancellation projection must not depend
  // on the old source being registered or replaying its intent.
  const restored = process.env.MAILBOX_CANCEL_RESTORED === "1";
  const format = process.env.MAILBOX_CANCEL_FORMAT as "generic" | "main" | "child" | undefined;
  const shared = format ? sharedCarrierFixture(format) : undefined;
  const fulfilledIndex = Number(process.env.MAILBOX_CANCEL_FULFILLED_INDEX ?? 0);
  const producer = shared?.producer ?? "pi-subagents";
  const endpoint = bindMailbox(pi).registerProducer({
    id: restored ? "pi-scheduler" : producer,
    checkCurrent: () => ({ kind: "allow", project: true, wake: false }),
    proveNative: (mail, branch) => ({ kind: "observed", entries: mail.messages.flatMap((carrier, messageIndex) => {
      const found = branch.find(entry => entry.type === "custom_message" && entry.customType === carrier.customType && entry.content === carrier.content);
      return found ? [{ messageIndex, entryId: found.id }] : [];
    }) }),
    onRecorded: notice => { log({ stage: "recorded", key: notice.key }); },
    onTerminal: evidence => { log({ stage: "terminal", evidence }); },
  });
  pi.on("session_start", (_event, context) => {
    ctx = context;
    const shared = (globalThis as any)[Symbol.for("pi.session-inject.mailbox.engine.v1")];
    log({ stage: "start", sessionId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), engineLoaded: !!shared.namespace, engineLoading: !!shared.loading });
  });
  // No arguments: the driver selects the deterministic mail by command name.
  for (const outcome of ["cancelled", "fulfilled"] as const) pi.registerCommand(`canceltest-${outcome}`, {
    handler: async (_args, context) => {
      mail = { producer, key: shared ? shared.keys[outcome === "fulfilled" ? fulfilledIndex : 1 - fulfilledIndex]! : outcome,
        anchorEntryId: context.sessionManager.getLeafId(), policy: "next-request", wake: false,
        messages: shared?.messages ?? [{ customType: "cancel-projection-body", content: outcome === "cancelled" ? "RELOAD_GATE_INPUT" : "FULFILLED_HISTORY", display: true, details: { outcome } }] };
      await endpoint.put(mail, endpoint.target(context)); log({ stage: "accepted", key: mail.key });
    },
  });
  pi.registerCommand("canceltest-cancel", { handler: async () => {
    if (!mail) throw Error("missing appended mail");
    const evidence = await endpoint.cancel(mail.key, "child generation ended");
    log({ stage: "cancelled", evidence });
  } });
  pi.on("agent_settled", () => { log({ stage: "settled", calls: faux.state.callCount }); });
}
