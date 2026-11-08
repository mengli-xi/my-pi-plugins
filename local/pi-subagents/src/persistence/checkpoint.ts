import { canonicalJson, sha256Hex } from "../capabilities/canonical.js";
import { compareCanonicalV1 } from "./canonical.js";

const HEX64 = /^[0-9a-f]{64}$/u;
const MAIN_KEY = /^main_[A-Za-z0-9_-]{32}$/u;
const AGENT_ID = /^agt_[A-Za-z0-9_-]{22}$/u;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CHECKPOINT_PATH = /^(?:root\.json|agents\/agt_[A-Za-z0-9_-]{22}\.json)$/u;

export interface CurrentPointerV1 {
  readonly version: 1;
  readonly checkpoint_generation: number;
  readonly journal_generation: number;
}

export interface FileDescriptorV1 {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface AgentCheckpointDescriptorV1 extends FileDescriptorV1 {
  readonly agent_id: string;
}

export interface CheckpointManifestV1 {
  readonly version: 1;
  readonly main_key: string;
  readonly generation: number;
  readonly host_revision: number;
  readonly last_journal_sequence: number;
  readonly created_at: string;
  readonly root: FileDescriptorV1;
  readonly agents: readonly AgentCheckpointDescriptorV1[];
  readonly state_sha256: string;
}

export interface CheckpointBundleV1 {
  readonly manifest: CheckpointManifestV1;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
  return value as number;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unknown or missing keys`);
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_MILLIS.test(value) || new Date(value).toISOString() !== value) throw new Error("checkpoint created_at is invalid");
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function descriptor(value: unknown, agent = false): FileDescriptorV1 | AgentCheckpointDescriptorV1 {
  const keys = agent ? ["file", "bytes", "sha256", "agent_id"] : ["file", "bytes", "sha256"];
  const object = exactObject(value, keys, agent ? "agent descriptor" : "file descriptor");
  if (typeof object.file !== "string" || !CHECKPOINT_PATH.test(object.file)) throw new Error("checkpoint descriptor path is invalid");
  const base = { file: object.file, bytes: integer(object.bytes, "descriptor bytes", 1), sha256: digest(object.sha256, "descriptor digest") };
  if (!agent) {
    if (base.file !== "root.json") throw new Error("root descriptor must name root.json");
    return Object.freeze(base);
  }
  if (typeof object.agent_id !== "string" || !AGENT_ID.test(object.agent_id) || base.file !== `agents/${object.agent_id}.json`) throw new Error("agent descriptor identity is invalid");
  return Object.freeze({ ...base, agent_id: object.agent_id });
}

export function generationHex(generation: number): string {
  integer(generation, "generation", 1);
  if (generation > 0xffff_ffff_ffff_ffff) throw new Error("generation exceeds 16 hex digits");
  return generation.toString(16).padStart(16, "0");
}

export function checkpointDirectoryName(generation: number): string {
  return `cp_${generationHex(generation)}`;
}

export function journalFileName(generation: number): string {
  return `jr_${generationHex(generation)}.bin`;
}

export function parseCurrentPointerV1(value: unknown): CurrentPointerV1 {
  const object = exactObject(value, ["version", "checkpoint_generation", "journal_generation"], "CURRENT");
  if (object.version !== 1) throw new Error("CURRENT version is invalid");
  return Object.freeze({
    version: 1,
    checkpoint_generation: integer(object.checkpoint_generation, "checkpoint_generation", 1),
    journal_generation: integer(object.journal_generation, "journal_generation", 1),
  });
}

export function encodeCurrentPointerV1(pointer: CurrentPointerV1): Uint8Array {
  const parsed = parseCurrentPointerV1(pointer);
  return Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
}

export function parseCheckpointManifestV1(value: unknown): CheckpointManifestV1 {
  const object = exactObject(value, ["version", "main_key", "generation", "host_revision", "last_journal_sequence", "created_at", "root", "agents", "state_sha256"], "checkpoint manifest");
  if (object.version !== 1 || typeof object.main_key !== "string" || !MAIN_KEY.test(object.main_key) || !Array.isArray(object.agents)) throw new Error("checkpoint manifest identity is invalid");
  const agents = object.agents.map((entry) => descriptor(entry, true) as AgentCheckpointDescriptorV1);
  const sorted = [...agents].sort((left, right) => compareCanonicalV1(left.agent_id, right.agent_id));
  if (agents.some((entry, index) => entry.agent_id !== sorted[index]!.agent_id)) throw new Error("checkpoint agents are not sorted by agent_id");
  if (new Set(agents.map((entry) => entry.agent_id)).size !== agents.length) throw new Error("checkpoint agent descriptors are duplicated");
  const root = descriptor(object.root) as FileDescriptorV1;
  const stateSha256 = digest(object.state_sha256, "checkpoint state digest");
  if (stateSha256 !== checkpointStateDigest(root, agents)) throw new Error("checkpoint state digest mismatch");
  return Object.freeze({
    version: 1,
    main_key: object.main_key,
    generation: integer(object.generation, "generation", 1),
    host_revision: integer(object.host_revision, "host_revision", 0),
    last_journal_sequence: integer(object.last_journal_sequence, "last_journal_sequence", 0),
    created_at: timestamp(object.created_at),
    root,
    agents: Object.freeze(agents),
    state_sha256: stateSha256,
  });
}

export function checkpointStateDigest(root: FileDescriptorV1, agents: readonly AgentCheckpointDescriptorV1[]): string {
  return sha256Hex(canonicalJson({ root, agents: [...agents] }));
}

export function descriptorFor(file: string, bytes: Uint8Array, agentId?: string): FileDescriptorV1 | AgentCheckpointDescriptorV1 {
  const value = agentId === undefined
    ? { file, bytes: bytes.byteLength, sha256: sha256Hex(bytes) }
    : { file, bytes: bytes.byteLength, sha256: sha256Hex(bytes), agent_id: agentId };
  return descriptor(value, agentId !== undefined);
}

export function buildCheckpointManifestV1(input: {
  mainKey: string;
  generation: number;
  hostRevision: number;
  lastJournalSequence: number;
  createdAt: string;
  rootBytes: Uint8Array;
  agents: ReadonlyMap<string, Uint8Array>;
}): CheckpointManifestV1 {
  const root = descriptorFor("root.json", input.rootBytes) as FileDescriptorV1;
  const agents = [...input.agents]
    .sort(([left], [right]) => compareCanonicalV1(left, right))
    .map(([agentId, bytes]) => descriptorFor(`agents/${agentId}.json`, bytes, agentId) as AgentCheckpointDescriptorV1);
  return parseCheckpointManifestV1({
    version: 1,
    main_key: input.mainKey,
    generation: input.generation,
    host_revision: input.hostRevision,
    last_journal_sequence: input.lastJournalSequence,
    created_at: input.createdAt,
    root,
    agents,
    state_sha256: checkpointStateDigest(root, agents),
  });
}

export function encodeCheckpointManifestV1(manifest: CheckpointManifestV1): Uint8Array {
  const parsed = parseCheckpointManifestV1(manifest);
  const bytes = Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
  if (bytes.byteLength > 1_048_576) throw new Error("checkpoint manifest exceeds 1 MiB");
  return bytes;
}

export function verifyCheckpointBundleV1(bundle: CheckpointBundleV1): void {
  const manifest = parseCheckpointManifestV1(bundle.manifest);
  const expected = new Map<string, FileDescriptorV1 | AgentCheckpointDescriptorV1>([[manifest.root.file, manifest.root]]);
  for (const agent of manifest.agents) expected.set(agent.file, agent);
  if (bundle.files.size !== expected.size) throw new Error("checkpoint contains missing or extra files");
  for (const [file, descriptorValue] of expected) {
    const bytes = bundle.files.get(file);
    if (!bytes) throw new Error(`checkpoint file is missing: ${file}`);
    if (bytes.byteLength !== descriptorValue.bytes || sha256Hex(bytes) !== descriptorValue.sha256) throw new Error(`checkpoint file descriptor mismatch: ${file}`);
  }
}
