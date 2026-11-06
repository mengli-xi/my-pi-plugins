import { isDeepStrictEqual } from "node:util";
import { MailboxError } from "./errors.js";
import type { Mail } from "./types.js";
export const same = isDeepStrictEqual;
export const recordKey = (mail: Pick<Mail, "producer" | "key">): string => JSON.stringify([mail.producer, mail.key]);
export const bodyKey = (mail: Mail, index: number): string => JSON.stringify([mail.producer, mail.key, index]);
export function invalid(message: string): never {
  throw new MailboxError("conflict", message);
}

/** Reject values JSON.stringify would silently drop, transform or coerce. */
export function cloneJson<T>(value: T): T {
  const stack = new Set<object>();
  function check(v: unknown): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || v === null) invalid("mailbox requires lossless plain JSON");
    if (stack.has(v)) invalid("cyclic mailbox JSON");
    stack.add(v);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) invalid("non-plain mailbox array");
      const descriptors = Object.getOwnPropertyDescriptors(v);
      const length = Object.getOwnPropertyDescriptor(v, "length")!.value as number;
      if (Reflect.ownKeys(descriptors).length !== length + 1 || "toJSON" in v) invalid("sparse or decorated mailbox array");
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable) invalid("sparse or decorated mailbox array");
        if (!("value" in descriptor)) invalid("mailbox JSON accessor");
        check(descriptor.value);
      }
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid("non-plain mailbox object");
      if (Reflect.ownKeys(v).length !== Object.keys(v).length) invalid("hidden mailbox JSON property");
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
        if (!("value" in descriptor)) invalid("mailbox JSON accessor");
        check(descriptor.value);
      }
    }
    stack.delete(v);
  }
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
