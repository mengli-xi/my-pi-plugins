/** Endpoint isolation stub for supervisor/UI unit tests only.
 * It accepts source intent without implementing native delivery or model runs.
 * SDK/faux integration uses the real mailbox runtime without this hook.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BindMailboxOptions, MailboxBinding, ProducerEndpoint } from "pi-session-inject/mailbox-v1";
import { registerHooks } from "node:module";

export function bindMailbox(pi: ExtensionAPI, _options?: BindMailboxOptions): MailboxBinding {
  let ctx: ExtensionContext | undefined;
  pi.on("session_start", (_event, current) => { ctx = current; });
  return {
    registerProducer(registration) {
      const token = Symbol("unit-test-producer");
      const endpoint: ProducerEndpoint = {
        id: registration.id, token,
        target(current) { return { slotKey: current.sessionManager.getSessionId(), session: { id: current.sessionManager.getSessionId(), file: null }, bindingGeneration: 1, producerToken: token }; },
        async activateNewExecution() { throw new Error("execution activation is outside supervisor/UI fixture scope"); },
        async put(mail) { if (!ctx) throw new Error("test endpoint not ready"); return { kind: "accepted", key: mail.key, revision: 1 }; },
        async cancel() { throw new Error("cancel is outside supervisor/UI fixture scope"); },
        async importFulfilled() { throw new Error("legacy import is outside supervisor/UI fixture scope"); },
        close() {},
      };
      return endpoint;
    }, close() {},
  };
}

export function installMailboxBindingStub(): void {
  registerHooks({ resolve(specifier, context, nextResolve) {
    if ((specifier === "pi-session-inject/mailbox-v1" || specifier === "pi-session-inject/mailbox-v1/light")) return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
}

export class MailboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
