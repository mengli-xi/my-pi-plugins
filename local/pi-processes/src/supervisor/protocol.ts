import { Buffer } from "node:buffer";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1_048_576;
const HEADER_BYTES = 4;
const HOST_NONCE = /^[0-9a-f]{64}$/;
const SAFE_TYPE = /^[A-Za-z][A-Za-z0-9.-]{0,95}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVELOPE_KEYS = new Set([
  "version",
  "hostNonce",
  "supervisorGeneration",
  "type",
  "requestId",
  "requestSequence",
  "eventSequence",
  "payload",
]);

export interface FrameV1<T extends Record<string, unknown> = Record<string, unknown>> {
  version: 1;
  hostNonce: string;
  supervisorGeneration: number;
  type: string;
  requestId?: string;
  requestSequence?: number;
  eventSequence?: number;
  payload: T;
}

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[process/${code}] ${message}`);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(object: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new ProtocolError("protocol-invalid", `unknown frame key ${JSON.stringify(key)}`);
  }
}

export function validateFrame(value: unknown): FrameV1 {
  if (!isRecord(value)) throw new ProtocolError("protocol-invalid", "frame payload must be an object");
  assertExactKeys(value, ENVELOPE_KEYS);
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError("protocol-version", "unsupported protocol version");
  }
  if (typeof value.hostNonce !== "string" || !HOST_NONCE.test(value.hostNonce)) {
    throw new ProtocolError("protocol-invalid", "hostNonce must be 32 lowercase hex bytes");
  }
  if (!isPositiveSafeInteger(value.supervisorGeneration)) {
    throw new ProtocolError("protocol-invalid", "supervisorGeneration must be a positive safe integer");
  }
  if (typeof value.type !== "string" || !SAFE_TYPE.test(value.type)) {
    throw new ProtocolError("protocol-invalid", "invalid frame type");
  }
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || !UUID_V4.test(value.requestId))) {
    throw new ProtocolError("protocol-invalid", "requestId must be a UUID v4");
  }
  if (value.requestSequence !== undefined && !isPositiveSafeInteger(value.requestSequence)) {
    throw new ProtocolError("protocol-invalid", "requestSequence must be a positive safe integer");
  }
  if (value.eventSequence !== undefined && !isPositiveSafeInteger(value.eventSequence)) {
    throw new ProtocolError("protocol-invalid", "eventSequence must be a positive safe integer");
  }
  if (!isRecord(value.payload)) throw new ProtocolError("protocol-invalid", "payload must be an object");
  return value as unknown as FrameV1;
}

function assertNoDuplicateObjectKeys(source: string): void {
  let index = 0;
  const whitespace = /\s/;

  const skipWhitespace = (): void => {
    while (index < source.length && whitespace.test(source[index]!)) index += 1;
  };

  const parseString = (): string => {
    const start = index;
    if (source[index] !== '"') throw new ProtocolError("protocol-invalid", "expected JSON string");
    index += 1;
    while (index < source.length) {
      const char = source[index++]!;
      if (char === '"') {
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          throw new ProtocolError("protocol-invalid", "invalid JSON string");
        }
      }
      if (char === "\\") {
        if (index >= source.length) break;
        index += 1;
      }
    }
    throw new ProtocolError("protocol-invalid", "unterminated JSON string");
  };

  const parseValue = (): void => {
    skipWhitespace();
    const char = source[index];
    if (char === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new ProtocolError("protocol-invalid", `duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        skipWhitespace();
        if (source[index++] !== ":") throw new ProtocolError("protocol-invalid", "expected JSON colon");
        parseValue();
        skipWhitespace();
        const delimiter = source[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new ProtocolError("protocol-invalid", "expected JSON object delimiter");
      }
      throw new ProtocolError("protocol-invalid", "unterminated JSON object");
    }
    if (char === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        parseValue();
        skipWhitespace();
        const delimiter = source[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new ProtocolError("protocol-invalid", "expected JSON array delimiter");
      }
      throw new ProtocolError("protocol-invalid", "unterminated JSON array");
    }
    if (char === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < source.length && !/[\s,}\]]/.test(source[index]!)) index += 1;
    if (index === start) throw new ProtocolError("protocol-invalid", "invalid JSON value");
  };

  parseValue();
  skipWhitespace();
  if (index !== source.length) throw new ProtocolError("protocol-invalid", "trailing JSON bytes");
}

function decodeJson(body: Buffer): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ProtocolError("protocol-invalid", "frame body is not valid UTF-8");
  }
  assertNoDuplicateObjectKeys(source);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ProtocolError("protocol-invalid", "frame body is not valid JSON");
  }
}

export function encodeFrame(frame: FrameV1): Buffer {
  validateFrame(frame);
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new ProtocolError("protocol-frame-size", `frame body must be 1..${MAX_FRAME_BYTES} bytes`);
  }
  const result = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, HEADER_BYTES);
  return result;
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): FrameV1[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new ProtocolError("protocol-invalid", "frame chunk must be bytes");
    }
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    const frames: FrameV1[] = [];
    while (this.#buffer.length >= HEADER_BYTES) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        throw new ProtocolError("protocol-frame-size", `invalid frame length ${length}`);
      }
      if (this.#buffer.length < HEADER_BYTES + length) break;
      const body = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      frames.push(validateFrame(decodeJson(body)));
    }
    return frames;
  }

  finish(): void {
    if (this.#buffer.length !== 0) {
      throw new ProtocolError("protocol-truncated", "transport ended with a partial frame");
    }
  }
}
