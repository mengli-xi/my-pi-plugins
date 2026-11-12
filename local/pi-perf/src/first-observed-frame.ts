import { protectInstrumentation } from "./ui-metrics.ts";
import { performance } from "node:perf_hooks";

/** A one-shot instance hook, not a second process-wide instrumentation owner. */
export function firstObservedFrame(target: object, painted: (at: number) => void): () => void {
  const original = protectInstrumentation("firstObservedFrame.read", () => Reflect.get(target, "doRender"));
  if (typeof original !== "function") return () => {};
  const descriptor = protectInstrumentation("firstObservedFrame.descriptor", () => Object.getOwnPropertyDescriptor(target, "doRender"));
  const restore = () => { protectInstrumentation("firstObservedFrame.restore", () => {
    if (Reflect.get(target, "doRender") !== wrapped) return;
    if (descriptor) Object.defineProperty(target, "doRender", descriptor);
    else Reflect.deleteProperty(target, "doRender");
  }); };
  function wrapped(this: object, ...args: unknown[]) {
    try {
      const value = Reflect.apply(original, this, args);
      // Restore before notifying: observer failure cannot retain this hook.
      restore();
      protectInstrumentation("firstObservedFrame.notify", () => painted(performance.now()));
      return value;
    } finally { restore(); }
  }
  if (!protectInstrumentation("firstObservedFrame.install", () => Reflect.set(target, "doRender", wrapped))) return () => {};
  return restore;
}
