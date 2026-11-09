import { MAILBOX_POLICIES } from "./types.js";

// JSON Schema draft 2020-12, not a TypeBox runtime dependency. All transport
// objects are exact; only producer details allows arbitrary plain JSON values.
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const string = { type: "string", minLength: 1 } as const;
const nullableId = { anyOf: [string, { type: "null" }] };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const array = (items: object, minItems = 0) => ({ type: "array", items, minItems });
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: "object", additionalProperties: false, properties, required,
});
const mailProperties = {
  producer: string, key: string, anchorEntryId: nullableId,
  policy: { enum: MAILBOX_POLICIES }, wake: { type: "boolean" },
  messages: array(ref("nativeMessage"), 1),
};
const evidenceProperties = {
  producer: string, key: string, terminalId: string, scope: ref("scope"),
};
const recorded = (ack: readonly string[]) => object({ notice: ref("recordedNotice"), ack: { enum: ack } });

/** Exact pending.json wire schema. Cross-record equality, same-key uniqueness,
 * callback requirements, scope/lineage, proof consistency, and terminal precedence
 * are additionally checked by parseMailboxSnapshot; schema alone is not proof. */
export const MAILBOX_PENDING_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:pi-session-inject:mailbox:pending:v1",
  ...object({
    version: { const: 1 }, session: ref("session"), revision: integer,
    suspended: { anyOf: [{ type: "null" }, ref("suspension")] },
    pending: array(ref("pendingRecord")), terminal: array(ref("terminalRecord")),
    attempt: ref("attempt"),
  }, ["version", "session", "revision", "suspended", "pending", "terminal"]),
  $defs: {
    jsonValue: {
      anyOf: [
        { type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string" },
        array(ref("jsonValue")),
        { type: "object", additionalProperties: ref("jsonValue") },
      ],
    },
    session: object({ id: string, file: nullableId, cwd: string }, ["id", "file"]),
    scope: object({ sessionId: string, anchorEntryId: nullableId }),
    nativeEntryRef: object({ messageIndex: integer, entryId: string }),
    text: object({ type: { const: "text" }, text: { type: "string" }, textSignature: { type: "string" } }, ["type", "text"]),
    image: object({ type: { const: "image" }, data: { type: "string" }, mimeType: string }),
    nativeMessage: object({
      customType: string,
      content: { anyOf: [{ type: "string" }, array({ oneOf: [ref("text"), ref("image")] })] },
      display: { type: "boolean" }, details: ref("jsonValue"),
    }, ["customType", "content", "display"]),
    mail: object(mailProperties),
    requiredCallbacks: object({ recorded: { type: "boolean" }, terminal: { type: "boolean" } }),
    recordedNotice: object({
      producer: string, key: string, scope: ref("scope"),
      recordedToken: string, entries: array(ref("nativeEntryRef"), 1),
    }),
    pendingRecorded: recorded(["pending", "acknowledged"]),
    terminalRecorded: recorded(["pending", "acknowledged", "superseded-by-cancel"]),
    legacyImport: object({
      proof: object({ sourceReceiptEntryId: string, assistantEntryId: string }),
      evidence: object({ ...evidenceProperties, outcome: { const: "fulfilled" }, assistantEntryId: string, nativeEntryIds: array(string, 1) }),
    }),
    terminalEvidence: {
      oneOf: [
        object({
          ...evidenceProperties, outcome: { const: "fulfilled" }, receiptEntryId: string,
          assistantEntryId: string, nativeEntryIds: array(string, 1),
        }),
        object({ ...evidenceProperties, outcome: { const: "cancelled" }, reason: string }),
      ],
    },
    pendingRecord: object({
      ...mailProperties, acceptedRevision: { ...integer, minimum: 1 },
      requiredCallbacks: ref("requiredCallbacks"), branchEntryId: nullableId,
      nativeEntries: array(ref("nativeEntryRef")),
      recorded: { anyOf: [{ type: "null" }, ref("pendingRecorded")] },
      legacyImport: ref("legacyImport"),
    }, [...Object.keys(mailProperties), "acceptedRevision", "requiredCallbacks", "branchEntryId", "nativeEntries", "recorded"]),
    terminalRecord: object({
      mail: ref("mail"), branchEntryId: nullableId, evidence: ref("terminalEvidence"),
      requiredCallbacks: ref("requiredCallbacks"),
      recorded: { anyOf: [{ type: "null" }, ref("terminalRecorded")] },
      terminalAck: { enum: ["pending", "acknowledged"] }, backingReceiptEntryId: nullableId,
    }),
    member: object({ producer: string, key: string, anchorEntryId: nullableId }),
    attempt: object({ id: string, members: array(ref("member")), sealedRevision: integer }),
    suspension: object({ reason: { enum: ["aborted", "error", "blocked"] }, detail: string }),
  },
} as const;
