import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { installPeer, log } from "./common.js";
export default function (pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "mailbox-faux", api: "mailbox-faux", models: [{ id: "fixture", reasoning: false, contextWindow: 32768, maxTokens: 128 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 12 }, () => async (context, _options, state) => {
    log({ stage: "request", call: state.callCount, messages: context.messages.filter(message => message.role !== "system").map(message => ({ role: message.role, content: message.content })) }); return fauxAssistantMessage(`DONE_${state.callCount}`);
  }));
  pi.registerProvider(faux.provider);
  installPeer(pi, "a");
}
