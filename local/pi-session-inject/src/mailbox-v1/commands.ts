import { MailboxError } from "./errors.js";
import { MAILBOX_COMMANDS, MAILBOX_COMMAND_DESCRIPTION } from "./constants.js";
import type { MailboxCommand, MailboxCommandFacade, MailboxCommandRouter } from "./types.js";

export function parseMailboxCommand(args: string): MailboxCommand {
  const words = args.trim().split(/\s+/);
  const command = words[0];
  if (!(MAILBOX_COMMANDS as readonly string[]).includes(command ?? "")) throw new MailboxError("conflict", "Usage: /mailbox status | resume | recover <session-id>");
  if (command === "recover" && words.length === 2 && words[1]) return { kind: "recover", sessionId: words[1] };
  if (command !== "recover" && words.length === 1) return { kind: command as "status" | "resume" };
  throw new MailboxError("conflict", "Usage: /mailbox status | resume | recover <session-id> (resume only releases transport hold)");
}
export function createMailboxCommandFacade(router: MailboxCommandRouter): MailboxCommandFacade {
  return {
    description: MAILBOX_COMMAND_DESCRIPTION,
    getArgumentCompletions(prefix) {
      const input = prefix.trimStart();
      if (input.startsWith("recover ")) {
        const term = input.slice(8);
        if (/\s/.test(term)) return null;
        try {
          const scope = router.completionScope();
          const targets = scope && router.recoveryTargets(scope.agentDir);
          const matches = targets?.filter(target => target.session.id.startsWith(term))
            .map(target => ({ value: `recover ${target.session.id}`, label: target.session.id }));
          return matches?.length ? matches : null;
        } catch { return null; }
      }
      const matches = MAILBOX_COMMANDS.filter(command => command.startsWith(input)).map(command => ({ value: command, label: command }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      try {
        const command = parseMailboxCommand(args);
        const route = router.current(ctx);
        if (!route) throw new MailboxError("not-ready", "Mailbox has no current session slot");
        if (command.kind === "recover") {
          const scope = router.completionScope();
          const target = scope && router.recoveryTargets(scope.agentDir)?.find(candidate => candidate.session.id === command.sessionId);
          if (!target) throw new MailboxError("unknown-key", "Mailbox recovery target is unavailable; inspect /mailbox status");
          ctx.ui.notify(`Recover mailbox session ${target.session.id} (${target.pendingCount} pending)`, "info");
          await router.recover(target, ctx); return;
        }
        if (command.kind === "resume") await route.resume();
        const status = await route.status();
        ctx.ui.notify(`Mailbox ${status.session.id}: ${status.pending.length} pending; ${status.recoveryHeld ? "recovery held" : "active"}; ${status.suspended ? `${status.suspended.reason}: ${status.suspended.detail}` : "not suspended"}; ${status.hasOwner ? "owner attached" : "no delivery owner"}; ${status.sourceAckPending} terminal/recorded awaiting source ACK`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  };
}
