import type { WakeConsumerReceiptV1 } from "#internal/types";
import type { Result } from "#internal/errors";
import { fail, ok } from "#internal/errors";

const encoder = new TextEncoder();
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export const LIMITS = Object.freeze({
  blocking: 256,
  detachedOffers: 256,
  subscribers: 64,
  ownerBytes: 64,
  logicalKeyBytes: 256,
  messageBytes: 512,
  sessionBytes: 512,
  receiptStringBytes: 256,
});

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function safeSingleLine(
  label: string,
  value: string,
  minBytes: number,
  maxBytes: number,
  allowEmpty: boolean,
): Result<string> {
  if (CONTROL_PATTERN.test(value)) {
    return fail("invalid-input", `${label} must not contain control characters`);
  }
  const normalized = value.trim();
  const size = bytes(normalized);
  if ((!allowEmpty && size < minBytes) || size > maxBytes) {
    return fail(
      "invalid-input",
      `${label} must be ${minBytes}..${maxBytes} UTF-8 bytes`,
    );
  }
  return ok(normalized);
}

export function validateSessionId(value: string): Result<string> {
  return safeSingleLine("sessionId", value, 1, LIMITS.sessionBytes, false);
}

export function validateOwnerId(value: string): Result<string> {
  if (!OWNER_PATTERN.test(value) || bytes(value) > LIMITS.ownerBytes) {
    return fail(
      "invalid-input",
      "ownerId must match [a-z0-9][a-z0-9._:/-]* and be at most 64 bytes",
    );
  }
  return ok(value);
}

export function validateConsumerId(value: string): Result<string> {
  return validateOwnerId(value);
}

export function validateLogicalKey(value: string): Result<string> {
  return safeSingleLine(
    "logicalKey",
    value,
    1,
    LIMITS.logicalKeyBytes,
    false,
  );
}

export function validateReason(
  value: string | undefined,
  required: boolean,
): Result<string | undefined> {
  if (value === undefined) {
    return required
      ? fail("invalid-input", "reason is required")
      : ok(undefined);
  }
  const validated = safeSingleLine(
    "reason",
    value,
    required ? 1 : 0,
    LIMITS.messageBytes,
    !required,
  );
  if (!validated.ok) return validated;
  return ok(validated.value || undefined);
}

export function validateSettlementMessage(value: string): Result<string> {
  const validated = safeSingleLine(
    "message",
    value,
    1,
    LIMITS.messageBytes,
    false,
  );
  return validated;
}

export function validateConsumerReceipt(
  value: unknown,
  expectedConsumerId: string,
  expectedConsumerGeneration: number,
): Result<WakeConsumerReceiptV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid-input", "consumer receipt must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = [
    "consumerGeneration",
    "consumerId",
    "continuationId",
    "scheduling",
    "version",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return fail("invalid-input", "consumer receipt has unknown or missing keys");
  }
  if (
    input.version !== 1 ||
    input.consumerId !== expectedConsumerId ||
    input.consumerGeneration !== expectedConsumerGeneration ||
    !Number.isSafeInteger(input.consumerGeneration) ||
    Number(input.consumerGeneration) <= 0 ||
    (input.scheduling !== "scheduled" && input.scheduling !== "coalesced") ||
    typeof input.continuationId !== "string"
  ) {
    return fail("invalid-input", "consumer receipt identity or values are invalid");
  }
  const consumerId = validateConsumerId(input.consumerId);
  if (!consumerId.ok) return consumerId;
  const continuationId = safeSingleLine(
    "continuationId",
    input.continuationId,
    1,
    LIMITS.receiptStringBytes,
    false,
  );
  if (!continuationId.ok) return continuationId;
  return ok(Object.freeze({
    version: 1 as const,
    consumerId: consumerId.value,
    consumerGeneration: input.consumerGeneration,
    continuationId: continuationId.value,
    scheduling: input.scheduling,
  }));
}
