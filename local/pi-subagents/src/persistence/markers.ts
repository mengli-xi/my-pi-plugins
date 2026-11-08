import { createHash } from "node:crypto";
import { mainKey } from "../domain/ids.js";
import { canonicalJsonV1, parseStrictJsonV1, validateUnicode } from "./canonical.js";

const NONCE43 = /^[A-Za-z0-9_-]{43}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

export interface StoreRootMarkerV1 { format: "pi-subagents-store"; version: 1; install_nonce: string; created_at: string }
export interface MainOwnerV1 { version: 1; main_key: string; main_session_id: string; main_session_sha256: string; created_at: string }

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("marker must be a plain object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error("marker has unknown or missing keys");
  return object;
}
function timestamp(value: unknown): string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value) throw new Error("marker timestamp is invalid"); return value; }
function encode(value: unknown): Uint8Array { return Buffer.from(`${canonicalJsonV1(value)}\n`, "utf8"); }
function parse(bytes: Uint8Array): unknown { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("marker must be one canonical JSON line"); const value = parseStrictJsonV1(Buffer.from(text.slice(0, -1))); if (canonicalJsonV1(value) !== text.slice(0, -1)) throw new Error("marker is not canonical JSON"); return value; }

export function decodeStoreRootMarkerV1(value: unknown): StoreRootMarkerV1 { const object = exact(value, ["format", "version", "install_nonce", "created_at"]); if (object.format !== "pi-subagents-store" || object.version !== 1 || typeof object.install_nonce !== "string" || !NONCE43.test(object.install_nonce)) throw new Error("store root marker identity is invalid"); return { format: "pi-subagents-store", version: 1, install_nonce: object.install_nonce, created_at: timestamp(object.created_at) }; }
export function encodeStoreRootMarkerV1(value: StoreRootMarkerV1): Uint8Array { return encode(decodeStoreRootMarkerV1(value)); }
export function parseStoreRootMarkerV1(bytes: Uint8Array): StoreRootMarkerV1 { return decodeStoreRootMarkerV1(parse(bytes)); }

export function decodeMainOwnerV1(value: unknown): MainOwnerV1 { const object = exact(value, ["version", "main_key", "main_session_id", "main_session_sha256", "created_at"]); if (object.version !== 1 || typeof object.main_session_id !== "string") throw new Error("Main owner identity is invalid"); validateUnicode(object.main_session_id); const bytes = Buffer.byteLength(object.main_session_id); if (bytes < 1 || bytes > 512) throw new Error("Main session id is invalid"); const expectedKey = mainKey(object.main_session_id); const digest = createHash("sha256").update(object.main_session_id, "utf8").digest("hex"); if (object.main_key !== expectedKey || object.main_session_sha256 !== digest || !HEX64.test(digest)) throw new Error("Main owner digest/key mismatch"); return { version: 1, main_key: expectedKey, main_session_id: object.main_session_id, main_session_sha256: digest, created_at: timestamp(object.created_at) }; }
export function createMainOwnerV1(mainSessionId: string, createdAt: string): MainOwnerV1 { return decodeMainOwnerV1({ version: 1, main_key: mainKey(mainSessionId), main_session_id: mainSessionId, main_session_sha256: createHash("sha256").update(mainSessionId).digest("hex"), created_at: createdAt }); }
export function encodeMainOwnerV1(value: MainOwnerV1): Uint8Array { return encode(decodeMainOwnerV1(value)); }
export function parseMainOwnerV1(bytes: Uint8Array): MainOwnerV1 { return decodeMainOwnerV1(parse(bytes)); }
