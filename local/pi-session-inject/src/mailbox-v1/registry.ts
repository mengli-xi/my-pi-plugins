import { MailboxError } from "./errors.js";

/** Process registries must be own data properties; never invoke or replace a
 * foreign accessor/inherited registration, even when it would return undefined. */
export function readRegistry(key: symbol): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (!descriptor) {
    if (!(key in globalThis)) return undefined;
  } else if ("value" in descriptor && descriptor.value !== undefined) {
    return descriptor.value;
  }
  throw new MailboxError("holder-incompatible", "mailbox registry must be an own defined data property");
}

export function getOrCreateRegistry<T>(key: symbol, create: () => T): T {
  const existing = readRegistry(key);
  if (existing !== undefined) return existing as T;
  const value = create();
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
  return value;
}
