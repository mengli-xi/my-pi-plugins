import { createHash } from "node:crypto";

const FORBIDDEN_UNICODE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

/** 规范 JSON 与所有持久数组共用的排序：按 UTF-8 字节序，永不受 locale/ICU 影响。 */
export function compareCanonicalV1(left: string, right: string): number { return compareUtf8(left, right); }

/** 返回不超过 limit 字节、且落在合法 UTF-8 边界上的前缀长度。 */
export function utf8PrefixLengthV1(bytes: Uint8Array, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("utf8 prefix limit is invalid");
  if (limit >= bytes.byteLength) return bytes.byteLength;
  let cut = limit;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return cut;
}

/** 把模型可见文本收进字节上限：先替掉游离代理对，再按码点边界截断。 */
export function boundedModelTextV1(value: string, maxBytes: number): string {
  const repaired = value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu, "�").normalize("NFC");
  const bytes = Buffer.from(repaired, "utf8");
  if (bytes.byteLength <= maxBytes) return repaired;
  return bytes.subarray(0, utf8PrefixLengthV1(bytes, maxBytes)).toString("utf8");
}

/** 按码点删掉尾部字符，直到不超过字节上限；绝不切开代理对。 */
export function trimToByteBudgetV1(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes && result.length > 0) {
    const tail = result.length >= 2 ? result.codePointAt(result.length - 2) : undefined;
    result = result.slice(0, result.length - (tail !== undefined && tail > 0xffff ? 2 : 1));
  }
  return result;
}

export function validateUnicode(value: string, modelVisible = false): string {
  if (value.normalize("NFC") !== value) throw new Error("string must be NFC normalized");
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new Error("string contains a lone surrogate");
  }
  if (!modelVisible && FORBIDDEN_UNICODE.test(value)) throw new Error("string contains forbidden controls");
  if (modelVisible && /[\u0000\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error("model-visible string contains forbidden controls");
  return value;
}

export function canonicalJsonV1(value: unknown): string { return encodeCanonicalJsonV1(value, false); }

/** Native delivery digests preserve finite costs and exact Unicode composition. */
export function canonicalDeliveryJsonV1(value: unknown): string { return encodeCanonicalJsonV1(value, true); }

function encodeCanonicalJsonV1(value: unknown, delivery: boolean): string {
  const stringValue = (text: string): string => {
    if (!delivery) return validateUnicode(text, true);
    if (/\p{Surrogate}/u.test(text)) throw new Error("delivery string contains a lone surrogate");
    return text;
  };
  const seen = new Set<object>();
  const encode = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "string") return JSON.stringify(stringValue(input));
    if (typeof input === "number") {
      if (!(delivery ? Number.isFinite(input) : Number.isSafeInteger(input)) || Object.is(input, -0)) throw new Error("canonical number must be a non-negative or signed safe integer without negative zero");
      return String(input);
    }
    if (!input || typeof input !== "object" || ArrayBuffer.isView(input) || input instanceof Date) throw new Error("canonical JSON accepts only plain JSON values");
    if (seen.has(input)) throw new Error("canonical JSON contains a cycle");
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype) throw new Error("canonical object must be plain");
    seen.add(input);
    try {
      if (Array.isArray(input)) return `[${input.map(encode).join(",")}]`;
      const object = input as Record<string, unknown>;
      const keys = Reflect.ownKeys(object);
      if (keys.some((key) => typeof key !== "string")) throw new Error("canonical object rejects symbol keys");
      return `{${(keys as string[]).sort(compareUtf8).map((key) => {
        if (delivery) stringValue(key); else validateUnicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || descriptor.value === undefined) {
          throw new Error("canonical object rejects accessors, hidden or undefined fields");
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(",")}}`;
    } finally {
      seen.delete(input);
    }
  };
  return encode(value);
}

export function sha256CanonicalV1(value: unknown): string {
  return createHash("sha256").update(canonicalJsonV1(value), "utf8").digest("hex");
}

function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = (): void => { while (/\s/u.test(text[index] ?? "")) index++; };
  const string = (): string => {
    const start = index;
    if (text[index++] !== '"') throw new Error("expected JSON string");
    while (index < text.length) {
      const character = text[index++];
      if (character === "\\") { if (index >= text.length) throw new Error("unterminated JSON escape"); index++; continue; }
      if (character === '"') return JSON.parse(text.slice(start, index)) as string;
      if (character !== undefined && character.charCodeAt(0) <= 0x1f) throw new Error("unescaped JSON control");
    }
    throw new Error("unterminated JSON string");
  };
  const primitive = (): void => {
    const start = index;
    while (index < text.length && !/[\s,}\]]/u.test(text[index] ?? "")) index++;
    if (start === index) throw new Error("invalid JSON value");
    JSON.parse(text.slice(start, index));
  };
  const value = (): void => {
    whitespace();
    if (text[index] === "{") return object();
    if (text[index] === "[") return array();
    if (text[index] === '"') { string(); return; }
    primitive();
  };
  const array = (): void => {
    index++; whitespace(); if (text[index] === "]") { index++; return; }
    while (true) { value(); whitespace(); const separator = text[index++]; if (separator === "]") return; if (separator !== ",") throw new Error("invalid JSON array"); }
  };
  const object = (): void => {
    index++; whitespace(); if (text[index] === "}") { index++; return; }
    const keys = new Set<string>();
    while (true) {
      whitespace(); const key = string(); if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`); keys.add(key);
      whitespace(); if (text[index++] !== ":") throw new Error("invalid JSON object"); value(); whitespace();
      const separator = text[index++]; if (separator === "}") return; if (separator !== ",") throw new Error("invalid JSON object");
    }
  };
  value(); whitespace(); if (index !== text.length) throw new Error("trailing JSON content");
}

export function parseStrictJsonV1(bytes: Uint8Array, maxBytes = 1_048_576): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new Error("JSON byte length is outside bounds");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error("JSON root must be a plain object");
  }
  canonicalJsonV1(parsed);
  return parsed;
}
