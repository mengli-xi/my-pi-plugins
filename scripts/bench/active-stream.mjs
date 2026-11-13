import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

// 可确定取消的本地流：已有真实可见正文，再等待 AbortSignal，不加入 provider sleep。
export function activeStream(model, _context, options) {
  const stream = new AssistantMessageEventStream();
  const message = { ...fauxAssistantMessage([]), model: model.id, provider: model.provider, api: model.api };
  queueMicrotask(() => {
    const abort = () => {
      message.stopReason = "aborted";
      message.errorMessage = "Request was aborted";
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
    };
    if (options.signal.aborted) return abort();
    options.signal.addEventListener("abort", abort, { once: true });
    stream.push({ type: "start", partial: message });
    message.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    message.content[0].text = "Benchmark response in progress";
    stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
  });
  return stream;
}
