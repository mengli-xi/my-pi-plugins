import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

/**
 * Faux provider for the BTW command-dispatch E2E. A request carrying
 * `HOLD:<name>` stays unresolved until the test writes `<name>.release`, and the
 * provider records when that request started, when its AbortSignal fired, and
 * when it finally resolved. The test uses those markers to prove the abort
 * arrived while the completion was still pending.
 *
 */
const markerDir = process.env.PI_BTW_TEST_MARKERS ?? "";
const requestLog = process.env.PI_BTW_TEST_REQUESTS ?? "";

function mark(name: string, event: string): void {
  if (!markerDir) return;
  writeFileSync(join(markerDir, `${name}.${event}`), `${JSON.stringify({
    event,
    wallClockMs: Date.now(),
    monotonicMs: performance.now(),
  })}\n`);
}

/** One line per completion: which model answered it, and with which reasoning. */
function logRequest(model: { provider: string; id: string }, options: SimpleStreamOptions | undefined, prompt: string): void {
  if (!requestLog) return;
  appendFileSync(requestLog, `${JSON.stringify({
    model: `${model.provider}/${model.id}`,
    reasoning: (options as { reasoning?: unknown } | undefined)?.reasoning ?? null,
    prompt,
  })}\n`);
}

/**
 * Answers the browser suite asks for by name, so one run can hold a Markdown
 * answer, a long scrollable answer, and a long Chinese question at once. Each
 * one marks itself answered, which is how the test knows the previous question
 * finished before it sends the next.
 */
const SCRIPTED: ReadonlyArray<{ match: string; marker: string; answer: string }> = [
  { match: "BTW_QUESTION_ONE", marker: "answer-one", answer: "BTW_PLAIN_ANSWER_ONE" },
  {
    match: "BTW_QUESTION_TWO",
    marker: "answer-two",
    answer: "## BTW_MD_HEADING\n\n- BTW_MD_ITEM_ONE\n- BTW_MD_ITEM_TWO\n\n> BTW_MD_QUOTE",
  },
  {
    match: "BTW_QUESTION_THREE",
    marker: "answer-three",
    answer: Array.from({ length: 60 }, (_line, index) =>
      `BTW_LONG_LINE_${String(index).padStart(2, "0")}`).join("\n"),
  },
];

async function holdUntilReleased(name: string, signal: AbortSignal | undefined): Promise<void> {
  const releaseFile = join(markerDir, `${name}.release`);
  mark(name, "started");
  signal?.addEventListener("abort", () => mark(name, "abort"), { once: true });
  while (!existsSync(releaseFile)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  mark(name, "resolved");
}

export default function btwFauxProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: "side-faux",
    api: "side-faux",
    models: [{ id: "side-faux-1", name: "Side Faux", contextWindow: 128_000, maxTokens: 1_024 }],
  });
  const respond = async (
    context: Context,
    options: SimpleStreamOptions | undefined,
    _state: unknown,
    model: { provider: string; id: string },
  ): Promise<AssistantMessage> => {
    const request = JSON.stringify(context.messages);
    logRequest(model, options, request);
    const heldName = /HOLD:([A-Za-z0-9_-]+)/u.exec(request)?.[1];
    if (heldName) {
      await holdUntilReleased(heldName, options?.signal);
      return fauxAssistantMessage(`BTW_HELD_ANSWER_${heldName.toUpperCase()}`);
    }
    const scripted = SCRIPTED.find((entry) => request.includes(entry.match));
    if (scripted) {
      mark(scripted.marker, "answered");
      return fauxAssistantMessage(scripted.answer);
    }
    if (request.includes("FAIL_THIS_REQUEST")) {
      await holdUntilReleased("failure", options?.signal);
      throw new Error("BTW_PROVIDER_FAILURE");
    }
    if (request.includes("BTW_SECOND_QUESTION")) return fauxAssistantMessage("BTW_SECOND_ANSWER");
    return fauxAssistantMessage("MAIN_TURN_DONE");
  };
  faux.setResponses(Array.from({ length: 24 }, () => respond));
  pi.on("session_start", () => {
    const readyFile = process.env.PI_SIDECHAT_TEST_READY_FILE;
    if (readyFile) writeFileSync(readyFile, "ready\n");
  });
  pi.registerProvider(faux.provider);
}
