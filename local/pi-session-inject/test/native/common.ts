import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { bindMailbox, MAILBOX_HOLDER_KEY, type MailboxHolder, type Mail } from "../../src/mailbox-v1/index.js";
import { fulfilledFinalAckLostFixture } from "../fixtures/fulfilled-final-ack-lost.js";

export function log(value: unknown): void { appendFileSync(process.env.MAILBOX_NATIVE_LOG!, JSON.stringify(value) + "\n"); }
export function installPeer(pi: ExtensionAPI, label: "a" | "b"): void {
  const scenario = process.env.MAILBOX_NATIVE_SCENARIO!;
  const id = label === "a" ? "pi-processes" : "pi-scheduler";
  let facade: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  const original = pi.registerCommand.bind(pi);
  pi.registerCommand = (name, definition) => {
    if (name === "mailbox") { facade = definition; log({ stage: "registered", label }); }
    original(name, definition);
  };
  let put = false, terminal = 0;
  const binding = bindMailbox(pi);
  const mail = (ctx: ExtensionContext): Mail => ({ producer: id, key: `native:${label}`,
    anchorEntryId: ctx.sessionManager.getLeafId(), policy: scenario.startsWith("active") ? "next-request" : "new-run", wake: true,
    messages: [{ customType: `native-body-${label}`, content: `MAILBOX_NATIVE_BODY_${label.toUpperCase()}`, display: false, details: { delivery: label } }] });
  const endpoint = binding.registerProducer({
    id,
    checkCurrent: () => ({ kind: "allow", project: true, wake: true }),
    proveNative: (mail, branch) => ({ kind: "observed", entries: mail.messages.flatMap((message, messageIndex) => {
      const matches = branch.filter(entry => entry.type === "custom_message" && entry.customType === message.customType && entry.content === message.content);
      if (matches.length > 1) throw new Error("duplicate native body");
      return matches[0] ? [{ messageIndex, entryId: matches[0].id }] : [];
    }) }),
    onTerminal: evidence => { terminal++; log({ stage: "terminal", label, evidence }); },
    settled: async (_event, ctx) => {
      if (scenario.startsWith("facade") || scenario.startsWith("active") || scenario.endsWith("recovery")) return;
      if (!put) {
        put = true;
        if (label === "b" && scenario.startsWith("deferred")) {
          if (scenario === "deferred-control-first") pi.sendUserMessage("USER");
          return;
        }
        if (scenario === "deferred-user-first" && label === "a") pi.sendUserMessage("USER");
        if (label === "b") await new Promise(resolve => setTimeout(resolve, 80));
        await endpoint.put(mail(ctx), endpoint.target(ctx));
      }
    },
  });
  pi.on("session_start", (event, ctx) => { log({ stage: "scope", label, reason: event.reason, sessionId: ctx.sessionManager.getSessionId() }); });
  if (scenario === "fulfilled-ack-recovery" && label === "b") pi.on("session_start", async (_event, ctx) => {
    const fixture = fulfilledFinalAckLostFixture(ctx.sessionManager.getSessionFile()!, ctx.cwd);
    const result = await endpoint.put(fixture.mail, endpoint.target(ctx));
    log({ stage: "repeated-put", result });
  });
  pi.on("context", async (_event, ctx) => {
    if (!scenario.startsWith("active") || put) return;
    put = true; await endpoint.put(mail(ctx), endpoint.target(ctx));
  });
  const overwrite = scenario.endsWith("clear") ? { entries: [], continue: false } : { continue: false };
  if (label === "b" && scenario.startsWith("active-turn")) pi.on("turn_end", () => overwrite);
  if (label === "b" && scenario.startsWith("active-settle")) pi.on("agent_before_settle", () => overwrite);
  pi.on("agent_settled", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const holder = (globalThis as unknown as { [key: symbol]: MailboxHolder })[Symbol.for(MAILBOX_HOLDER_KEY)]!;
    const slot = [...holder.slots.values()].find(slot => slot.session.id === ctx.sessionManager.getSessionId());
    log({ stage: "settled", label, terminal, bodies: branch.filter(entry => entry.type === "custom_message" && entry.customType.startsWith("native-body-")).length,
      controls: branch.filter(entry => entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1").length,
      idleControls: slot && [...slot.submitted.idleControls.values()].map(control => ({ id: control.details.attemptId, started: !!control.start })) });
  });
  pi.registerCommand(`mailtest-close-${label}`, { handler: async () => { endpoint.close(); log({ stage: "owner-closed", label }); } });
  pi.registerCommand(`mailtest-inspect-${label}`, { handler: async () => {
    const answers: Record<string, unknown> = {};
    for (const prefix of ["", "st", "res", "recover ", "recover missing", "unknown"]) answers[prefix] = await facade?.getArgumentCompletions?.(prefix) ?? null;
    const recover = answers["recover "] as { value: string }[] | null;
    const prefix = recover?.[0]?.value.slice(0, 16);
    const partialRecover = prefix ? { prefix, answers: await facade?.getArgumentCompletions?.(prefix) } : null;
    log({ stage: "inspect", label, names: pi.getCommands().filter(command => command.name.startsWith("mailbox")).map(command => command.name), answers, partialRecover });
  } });
  pi.registerCommand(`mailtest-reload-${label}`, { handler: async (_args, ctx) => { await ctx.reload(); log({ stage: "reloaded" }); } });
}
