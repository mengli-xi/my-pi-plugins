import { MAILBOX_ABI_VERSION, MAILBOX_TRANSPORT_BUILD_ID } from "./constants.js";
import { MailboxError } from "./errors.js";
import { getOrCreateRegistry } from "./registry.js";
type Engine = typeof import("./engine.js");
const KEY = Symbol.for("pi.session-inject.mailbox.engine.v1");
interface EngineHolder {
  version: typeof MAILBOX_ABI_VERSION;
  transportBuildId: typeof MAILBOX_TRANSPORT_BUILD_ID;
  namespace: Engine | null;
  loading: Promise<Engine> | null;
}
function compatible(namespace: Engine): boolean {
  return (
    namespace.version === MAILBOX_ABI_VERSION &&
    namespace.transportBuildId === MAILBOX_TRANSPORT_BUILD_ID &&
    typeof namespace.attachSlot === "function" &&
    typeof namespace.commandFacade === "function" &&
    typeof namespace.refreshRecovery === "function" &&
    typeof namespace.recover === "function" &&
    typeof namespace.releaseDiskSession === "function"
  );
}
function holder(): EngineHolder {
  const value = getOrCreateRegistry<EngineHolder>(KEY, () => ({
    version: MAILBOX_ABI_VERSION,
    transportBuildId: MAILBOX_TRANSPORT_BUILD_ID,
    namespace: null,
    loading: null,
  }));
  if (
    !value ||
    value.version !== MAILBOX_ABI_VERSION ||
    value.transportBuildId !== MAILBOX_TRANSPORT_BUILD_ID ||
    !Object.hasOwn(value, "namespace") ||
    !Object.hasOwn(value, "loading") ||
    (value.namespace !== null && !compatible(value.namespace)) ||
    (value.loading !== null && typeof value.loading?.then !== "function")
  ) {
    throw new MailboxError("holder-incompatible", "mailbox engine ABI/build/method mismatch; no private delivery fallback");
  }
  return value;
}
export function checkEngineHolder(): void {
  holder();
}
export function loadedEngine(): Engine | null {
  return holder().namespace;
}
/** Each extension has its own loader/module graph. Only the winner evaluates
 * the dynamic import; everyone else receives this exact process-wide promise. */
export function loadEngine(): Promise<Engine> {
  const value = holder();
  if (!value.loading) {
    const loading = import("./engine.js")
      .then((namespace) => {
        if (!compatible(namespace)) throw new MailboxError("holder-incompatible", "mailbox engine namespace ABI/build/method mismatch");
        value.namespace = namespace;
        return namespace;
      })
      .catch((error) => {
        if (value.loading === loading) value.loading = null;
        throw error;
      });
    value.loading = loading;
  }
  return value.loading;
}
