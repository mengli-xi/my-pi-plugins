import { createHash } from "node:crypto";

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input) || Object.is(input, -0)) throw new Error("canonical JSON numbers must be safe integers");
      return String(input);
    }
    if (!input || typeof input !== "object" || ArrayBuffer.isView(input) || input instanceof Date) {
      throw new Error("canonical JSON accepts only plain JSON values");
    }
    if (seen.has(input)) throw new Error("canonical JSON contains a cycle");
    if (Object.getPrototypeOf(input) !== Object.prototype && !Array.isArray(input)) {
      throw new Error("canonical JSON objects must be plain");
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) return `[${input.map(encode).join(",")}]`;
      const object = input as Record<string, unknown>;
      const keys = Reflect.ownKeys(object);
      if (keys.some((key) => typeof key !== "string")) throw new Error("canonical JSON rejects symbols");
      return `{${(keys as string[]).sort(compareUtf8).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || descriptor.value === undefined) {
          throw new Error("canonical JSON rejects accessors, hidden, and undefined values");
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(",")}}`;
    } finally {
      seen.delete(input);
    }
  };
  return encode(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
